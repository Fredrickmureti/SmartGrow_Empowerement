
# AccrualFlow Edge — Architecture Audit & Evolution Plan

## 1. Current State Assessment

**What exists** (`agent/`): a Node.js HTTP server on `http://localhost:8043`, shared-secret bearer auth (token in `~/.pos-agent-token`), route handlers for `/status`, `/print`, `/test`, `/discover`, `/usb/devices`, `/usb/print`, `/biometric/*`. CORS restricted to `localhost:8080/3000` and `127.0.0.1:*`. Browser client `AgentClient.ts` probes with circuit-breaker + per-endpoint mutex. No installer, no GUI, no TLS, no code signing, no update channel, no telemetry, single flat token, endpoint-based routing keyed on `ipAddress:port`.

**Strengths**: clean per-role route split, idempotent request contracts, per-endpoint FIFO mutex, discovery already backgrounded, biometric dispatcher already generic enough to plug vendors in.

**Weaknesses vs enterprise bar**:
- Plaintext HTTP loopback → mixed-content block from `https://www.accrualflow.systems/`. Every modern browser refuses `fetch('http://localhost:8043')` from an HTTPS origin except in the narrow "Private Network Access" secure-context carve-out, and even that requires a CORS-preflighted `Access-Control-Allow-Private-Network: true` header the agent does not send.
- Auth is a static, never-rotated shared secret with no origin binding, no device binding, no user binding, no replay window.
- No CSRF/DNS-rebinding defense (a malicious page on any origin can hit `127.0.0.1:8043` once it learns the token; DNS rebinding can bypass Origin checks entirely without a Host allowlist).
- Configuration is source-code + terminal; no operator-facing surface.
- Device model is endpoint-shaped (`ip:port`, `vid:pid`) not capability-shaped, so the ERP has to know printer languages, transports, and paper geometry per site.
- No signed installer, no auto-update, no crash reporting, no support bundle.
- Terminology ("POS Hardware Agent") understates scope; the same runtime already handles biometrics and will hold scales, drawers, EFT terminals, scanners, displays, RFID, cameras.

## 2. How Mature Platforms Solve This

Common architectural pattern across Shopify Hardware Connector, Square Hardware Hub, Lightspeed Hub, Zebra Browser Print, Epson TM-Utility, Star CloudPRNT, Oracle Simphony Workstation, SAP POSDM:

- **Named native app + signed installer** (MSI/PKG/DEB) installed per workstation, running as a background service with a tray/menu-bar UI. Not a `npm run dev` process.
- **HTTPS on loopback with a locally-trusted certificate**, or a same-origin cloud relay. Two families dominate:
  1. *Local HTTPS*: bind `127.0.0.1` with a cert whose CA is added to the OS trust store at install time (Zebra, Epson, Square older versions).
  2. *Cloud relay / outbound WebSocket*: the agent opens a persistent outbound TLS WebSocket to the ERP; the browser never talks to the agent directly (Shopify, newer Square, Lightspeed Hub, Star CloudPRNT, Oracle Retail EFTLink cloud mode). This kills mixed-content, CORS, and DNS-rebinding as concerns.
- **Capability negotiation**: the agent publishes a manifest (`{ printers:[{lang:'escpos', width_mm:80, cutter:true}], scales:[…], drawers:[…], eft:[…] }`); the ERP renders against capabilities, not device IDs.
- **Per-workstation identity**: each install enrols with the tenant, gets a device certificate or long-lived credential bound to workstation + tenant + user set; short-lived tokens are minted from it.
- **Plugin driver model**: transports (USB/serial/TCP/Bluetooth/HID) and role adapters (ESC/POS, ZPL, EPL, OPOS, JPOS, CUPS) are separate concerns behind a stable command AST — matches ADRs 0085–0089 already in this repo.
- **Observability**: structured logs on disk, ring-buffered in-memory, one-click "support bundle" export, opt-in crash reporting, health endpoint the ERP can poll.
- **Auto-update** over a signed channel (Squirrel/electron-updater/MSIX/APT).

## 3. Chosen Model for AccrualFlow

**Name**: `AccrualFlow Edge` (the runtime) shipped as **AccrualFlow Edge Desktop** (the tray app). "Hardware Agent" retained internally as the runtime component name.

**Transport**: dual-mode, capability-negotiated at startup:
1. **Primary — Outbound WebSocket relay** to `wss://edge-relay.accrualflow.systems/ws` authenticated with the device certificate. The web ERP sends print/scan/biometric intents through the same Supabase-brokered channel; the agent picks them up and ACKs. This is the only mode that works cleanly from `https://www.accrualflow.systems/` on every browser, every OS, every network, without any browser or OS trust-store manipulation.
2. **Fallback — Local HTTPS loopback** on `https://127.0.0.1:8443` using a per-install certificate whose root is added to the OS trust store by the signed installer, with `Access-Control-Allow-Private-Network: true` + strict Origin allowlist + Host-header pinning (DNS-rebinding defense). Used when the workstation is offline from the relay but the browser is on the same LAN, and for latency-sensitive ops (cash drawer kick, scale tare).

The ERP client picks relay-first, loopback-second, transparently.

**Identity & Auth**:
- Enrolment: operator signs into AccrualFlow in the desktop app once; agent gets a workstation certificate (mTLS to relay) + a rotating short-lived JWT.
- Per-request: JWT bound to `{tenant_id, workstation_id, user_id, nbf, exp≤5min}`, verified by the relay and by the loopback listener.
- Origin binding: loopback verifies `Origin` against a signed allowlist fetched at enrolment (includes `https://www.accrualflow.systems` and tenant custom domains); rebinding blocked by pinning `Host: 127.0.0.1:8443`.
- Replay: nonce cache with 5-minute TTL for mutating ops.
- Token lifecycle: rotated on every ERP session; revocable per-workstation from admin console.

**Device Model — capability, not endpoint**:
```
Workstation
 └── Devices[] { id, role, transport, driver, capabilities{}, health, last_seen }
       roles: receipt_printer | label_printer | scanner | drawer |
              scale | display | eft_terminal | biometric | signature_pad |
              rfid_reader | camera
```
ERP calls `edge.dispatch({ role, capability_needs, payload, idempotency_key })`; Edge resolves the concrete device. Aligns with existing `HardwareClient.exec({role, op, payload, idempotencyKey})` contract — no ERP-side refactor needed.

**Plugin Driver Architecture**:
- `packages/edge-runtime` — core, transports, dispatcher, relay client, loopback listener, capability registry.
- `packages/edge-drivers-*` — one npm workspace per role (receipt, label, scale, drawer, eft, biometric, scanner…). Drivers export a manifest + implement `probe()`, `open()`, `execute(command)`, `close()`, `healthcheck()`.
- Third-party or tenant-specific drivers load from a signed `~/.accrualflow/edge/plugins/` directory, verified against the AccrualFlow signing key. Reuses the ADR-0084/0085 `Line[]` AST for print so drivers stay thin.

**Desktop Shell (GUI)**:
Electron app (reuses this repo's existing `electron/` scaffolding and driver code) providing:
- Onboarding / enrolment wizard (tenant, workstation name, sign-in).
- Dashboard: connection status (relay + loopback), workstation identity, last activity.
- Devices: live inventory, add/remove/rename, per-device test action, capability view.
- Diagnostics: printer test page, scan capture, drawer kick, scale read, biometric enrol test, USB tree, network reachability.
- Logs: viewer with filter/download, one-click support bundle (logs + config redacted + system info).
- Auth: view workstation ID, rotate credential, revoke, sign out.
- Updates: channel selector, current version, "check now", release notes.
- Settings: port, log level, proxy, allowed origins, offline queue caps.
- About: version, license, links.
Runs as a **tray application with a background service child**; on Windows also as an optional Windows Service so it survives logout; on Linux as a systemd user unit; on macOS as a LaunchAgent.

**Deployment**:
- Signed MSI (Windows, code-signed with EV cert, WinGet + direct download).
- Signed PKG + notarized (macOS, DMG + Homebrew cask).
- Signed DEB/RPM + AppImage (Linux, apt repo).
- Auto-update via `electron-updater` on a versioned channel; staged rollout (10% → 50% → 100%).

**Observability**:
- Structured NDJSON logs on disk with daily rotation.
- In-memory ring buffer surfaced in GUI.
- OpenTelemetry traces for each dispatch (opt-in, tenant-controlled).
- Crash reporter (Sentry-compatible, tenant-controlled DSN).
- `/health` on loopback and heartbeat over relay every 30s.
- Support bundle: logs, redacted config, driver list, OS info, recent events → zip → attach to support ticket from the GUI.

## 4. Communication Model Summary

```text
Browser (https://www.accrualflow.systems)
   │
   │ 1. Supabase Realtime channel `workstation:{id}` (primary, always works from HTTPS)
   ▼
Relay (wss://edge-relay.accrualflow.systems)
   │  mTLS(device cert) + JWT(user)
   ▼
AccrualFlow Edge Desktop  ── loopback https://127.0.0.1:8443 (fallback, same-LAN)
   │
   ├── Driver: receipt/escpos  → USB/TCP/serial
   ├── Driver: label/zpl       → USB/TCP
   ├── Driver: scale/ncr       → serial/HID
   ├── Driver: drawer          → printer passthrough / GPIO
   ├── Driver: eft/nexo        → TCP/serial
   ├── Driver: biometric       → vendor SDK bridge
   └── Driver: scanner         → HID/serial/BT
```

## 5. Implementation Roadmap

Sequenced so each phase ships value and preserves the current localhost flow until the replacement is proven.

### Phase 0 — Report & rename (this plan)
Publish the audit; introduce name `AccrualFlow Edge`; keep `agent/` running unchanged.

### Phase 1 — Harden the existing agent (2 wks)
- DNS-rebinding defense: enforce `Host` header ∈ `{127.0.0.1:8043, localhost:8043}`.
- Origin allowlist tightened + `Access-Control-Allow-Private-Network: true` on preflight.
- JWT-shaped tokens with `exp`, `nbf`, `aud`, `tenant`, `workstation`, replacing flat shared secret. Rotation endpoint.
- Nonce replay cache on mutating routes.
- Structured NDJSON logging + `/health` endpoint distinct from `/status`.
- Support bundle CLI: `accrualflow-edge support-bundle`.

### Phase 2 — Relay transport (3 wks)
- Ship `edge-relay` as a Supabase Edge Function + Supabase Realtime channel per workstation (reuses existing auth + RLS; no new infra).
- Agent opens outbound Realtime subscription on start; consumes commands, publishes ACKs.
- Client `AgentClient` gains a `RelayTransport` sibling; probes relay first, loopback second.
- End-to-end: production ERP prints via relay with zero loopback dependency.

### Phase 3 — Capability model (2 wks)
- Introduce `WorkstationManifest` published by agent on connect + on device change.
- ERP `hardwareClient.exec` resolves via capabilities; endpoint-shaped calls deprecated but supported for one release.
- Persist manifest in `workstation_devices` table (RLS: tenant + workstation).

### Phase 4 — Desktop shell (4 wks)
- Electron app wrapping the runtime; onboarding wizard; device dashboard; diagnostics; logs; token management; updates.
- Tray icon + background service supervision.
- Signed installers for Win/macOS/Linux; auto-update channel.

### Phase 5 — Plugin drivers (ongoing)
- Split existing ESC/POS, ZPL, USB, biometric into `edge-drivers-*` workspaces behind the driver interface.
- Add scanner, drawer, scale, EFT, customer display, RFID drivers incrementally.
- Signed plugin loader for third-party drivers.

### Phase 6 — Observability + Admin (2 wks)
- OpenTelemetry hooks, Sentry-compatible crash reporter, admin console page listing workstations, versions, health, last seen, revoke button.
- Update rollout controls.

## 6. Technical Details (dev-facing)

- **Repo layout target**:
  ```
  edge/
    packages/runtime/          (ex agent/src, plus relay client)
    packages/desktop/          (Electron shell)
    packages/drivers-receipt/
    packages/drivers-label/
    packages/drivers-scanner/
    packages/drivers-scale/
    packages/drivers-drawer/
    packages/drivers-eft/
    packages/drivers-biometric/
    packages/shared/           (Line[] AST, capability types, protocol)
    installers/{win,mac,linux}/
  ```
- **Command AST**: reuse `Line[]` from ADR-0084/0085 for print; introduce analogous ASTs for `ScaleReading`, `ScanEvent`, `DrawerCommand`, `EftIntent`.
- **Relay protocol**: JSON envelope `{ id, workstation, role, op, payload, idempotency_key, deadline_ms }` → `{ id, ok, result | error, telemetry }`. At-most-once via `idempotency_key`, at-least-once retry from ERP with same key.
- **Loopback TLS**: per-install cert generated by installer via `mkcert`-equivalent bundled tool, installed into OS trust store; cert pinned in the ERP client after enrolment.
- **Migration path for existing `agent/`**: no breaking rename; `pos-hardware-agent` becomes a thin re-export from `@accrualflow/edge-runtime`; `~/.pos-agent-token` continues to work until Phase 1 rotation runs.
- **Guardrails**: extend existing ESLint rules (`no-raw-hardware-ipc`, `no-raw-escpos-bytes`, `no-raw-zpl-outside-printing`) to also forbid direct `fetch('http://localhost:8043')` from `src/` outside `local-agent/`.
- **Backwards compatibility**: current `AgentClient` remains the single browser chokepoint; only its internals change.

## 7. Definition of Done

- Production ERP at `https://www.accrualflow.systems` prints, scans, and reads biometrics against a customer workstation without any HTTP-on-HTTPS or CORS caveats, without asking the customer to disable browser security.
- Customer installs one signed installer, sees a branded desktop app, enrols their workstation in under 2 minutes, and never opens a terminal.
- Adding a new device category is a new `edge-drivers-*` package + capability entry, not a runtime change.
- Support engineers can retrieve logs, health, and version for any workstation from the admin console without shell access to the customer machine.
- Every credential is short-lived, workstation-bound, tenant-bound, and revocable.
