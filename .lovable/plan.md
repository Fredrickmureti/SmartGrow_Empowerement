
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

**Legend:** ✅ Shipped & verified · 🚧 Active · ⏳ Pending

### ✅ Phase 0 — Report & rename
Audit published; runtime renamed to `AccrualFlow Edge`; existing `agent/` kept operational.

### ✅ Phase 1 — Harden the existing agent
Shipped in `agent/` at `v1.1.0-edge.p1`. Verified via `bunx tsgo` and route contract tests.
- Loopback-only bind (127.0.0.1), `Host` header pinning (DNS-rebinding defense).
- `Access-Control-Allow-Private-Network: true` + tightened Origin allowlist (adds `https://www.accrualflow.systems`).
- `X-Edge-Nonce` replay protection on mutating routes.
- Structured NDJSON logger + in-memory ring buffer (`agent/src/logger.ts`).
- `/health` and authenticated `/support-bundle` endpoints.
- Nonce-aware `AgentClient` on the browser side.
- (JWT-shaped rotation is deferred — the workstation-secret path in Phase 2 supersedes it for the relay leg.)

### ✅ Phase 2 — Relay transport
Shipped at `v1.2.0-edge.p2`. Verified by full-app typecheck; end-to-end runtime verification requires an enrolled workstation.
- Migration `20260726020046_*`: `public.workstations`, `public.edge_jobs` (+ `edge_jobs_expire_stale` RPC, unique idempotency index, Realtime enabled).
- Edge functions: `edge-workstation-register` (org-authed enrolment, secret shown once, SHA-256 stored), `edge-agent-poll`, `edge-agent-complete` (both workstation-secret authed).
- Client `RelayTransport` (enqueue → race Realtime UPDATE vs poll vs hard timeout, idempotency-key reuse).
- `AgentClient.enableRelay/disableRelay/isRelayEnabled`; `printNetwork`, `testConnection`, `printUsb` prefer relay and fall through to loopback.
- Agent `relay.ts` polls the edge functions with the workstation secret, dispatches to existing route handlers, auto-starts when `~/.accrualflow/edge/workstation.json` (or `$ACCRUALFLOW_EDGE_CONFIG`) exists.
- Documented in `agent/README.md` (enrolment, config file shape, env vars).

### ✅ Phase 3 — Capability model
Shipped at `v1.3.0-edge.p3`. Verified: migration applied, edge function deployed, full-app typecheck clean.
- Migration: `public.workstation_devices` (device_key, role, transport, driver, name, capabilities jsonb, health, last_seen_at, metadata; unique on (workstation_id, device_key); org-scoped RLS; Realtime on) and `public.workstation_manifests` (payload jsonb history; org-scoped RLS; Realtime on).
- Edge function `edge-workstation-manifest` (workstation-secret authed): validates roles/transports, upserts the current device set, marks vanished devices `health='offline'`, inserts a manifest snapshot, updates the workstation heartbeat + version.
- Agent `manifest.ts`: builds a manifest from USB hints (Epson/Star/Zebra/Bixolon vid tables → capabilities such as `width_mm`, `cutter`) plus the existing network discovery, publishes on start + every 60 s; wired into `index.ts` with SIGINT/SIGTERM cleanup.
- Client `CapabilityResolver` (`src/services/hardware/local-agent/CapabilityResolver.ts`): `resolve({ workstationId, role, needs, healthIn })` picks the best-matching device (capability-match score → health → last-seen recency); `listForWorkstation` for admin UI.
- All prior endpoint-shaped calls remain intact (deprecated but functional through one more release, per plan §5.3).

### 🚧 Phase 4 — Desktop shell (next)
Owner: next agent. Recommended entry point: `packages/desktop/` Electron scaffold — reuse the existing top-level `electron/main.cjs` pattern (see `<electron-desktop-app>` in system knowledge for the `base: './'` and `.cjs` requirements).
- Onboarding wizard invoking `edge-workstation-register` and writing `~/.accrualflow/edge/workstation.json` (mode 0600).
- Dashboard: relay + loopback status, workstation identity, last activity — powered by the Realtime subscriptions already enabled in Phases 2/3.
- Devices tab: renders `workstation_devices` live; per-device Test button that enqueues an `edge_jobs` row and awaits the result via `RelayTransport`.
- Diagnostics: printer test page, USB tree, network reachability, scale/drawer read (behind capability gates from Phase 3).
- Logs viewer + one-click support bundle export (already exposed by `/support-bundle`).
- Auth: view workstation ID, rotate credential (new endpoint required: `edge-workstation-rotate-secret`), revoke.
- Tray icon + background service supervision; signed installers (Win/macOS/Linux) with `@electron/packager` per sandbox constraints.

### ⏳ Phase 5 — Plugin drivers
Split ESC/POS, ZPL, USB, biometric into `packages/edge-drivers-*` behind a `probe/open/execute/close/healthcheck` interface. Signed plugin loader in `~/.accrualflow/edge/plugins/`.

### ⏳ Phase 6 — Observability + Admin
OpenTelemetry hooks; Sentry-compatible crash reporter; admin console page (workstations list, versions, health, revoke, staged update rollout).


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

## 8. Handoff — Instructions for the Next Agent

**Before writing new code, verify Phase 3 is enterprise-grade complete:**

1. **Migration integrity** — Confirm `public.workstation_devices` and `public.workstation_manifests` exist with org-scoped RLS, the (workstation_id, device_key) unique index, `updated_at` triggers, and Realtime enabled. Run `supabase--read_query` against `pg_policies` + `pg_publication_tables`.
2. **Edge function `edge-workstation-manifest`** — Manually exercise via `supabase--curl_edge_functions` with a real `X-Workstation-Id` + workstation secret; confirm (a) unknown workstations return 404, (b) mismatched secret returns 401, (c) role/transport validation rejects garbage, (d) devices absent from a subsequent publish flip to `health='offline'`.
3. **Agent manifest publisher** — Confirm `agent/src/manifest.ts` runs only when `workstation.json` is present, publishes on start + every 60 s, and never crashes when the `usb` module is missing.
4. **Client resolver** — Confirm `CapabilityResolver.resolve` ranks by capability-match then health then recency and returns `null` on negative-score winners (regression risk: don't silently pick a wrong-capability device).
5. **No orphaned surface** — There is no UI wired to `workstation_devices` yet. That's intentional: it belongs to Phase 4. Do not add ad-hoc pages under `src/pages/` for it; build them inside the Electron shell.

**Once verification is green, start Phase 4 — Desktop shell:**

- Scaffold `packages/desktop/` Electron app; follow the `<electron-desktop-app>` rules (`base: './'` in `vite.config.ts`, `.cjs` main, `@electron/packager`).
- First deliverable = **onboarding wizard**: signs in via existing Supabase auth, calls `edge-workstation-register`, writes `~/.accrualflow/edge/workstation.json` with mode 0600. This unblocks every subsequent Phase 4 milestone.
- Then Dashboard → Devices → Diagnostics → Logs → Auth, in that order, so each tab lands atop a stable data path.

**Do not** jump ahead to Phase 5 (plugin drivers) or Phase 6 (observability) — the desktop shell is the operator-visible surface the plan promised and everything downstream assumes it exists.
