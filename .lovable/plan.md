
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

### ✅ Phase 4.1 — Desktop shell (scaffold complete)
Shipped in `packages/desktop/` at `0.1.0`. Verified: root-app `bunx tsgo` clean (the desktop package is outside `tsconfig.app.json`'s include set, so it typechecks independently in its own workspace).

Delivered:
- Electron scaffold under `packages/desktop/` following the `<electron-desktop-app>` rules — `.cjs` main, `base: './'` in `vite.config.ts`, `@electron/packager` for packaging (not `electron-builder`).
- `electron/main.cjs` — tray-first supervisor: OS window, tray menu, atomic mode-0600 write of `~/.accrualflow/edge/workstation.json`, child-process supervision of the agent runtime (`ACCRUALFLOW_EDGE_CONFIG` pre-injected).
- `electron/preload.cjs` — context-isolated IPC surface exposed as `window.edge` (workstation, settings, agent, shell). Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Onboarding wizard** (`src/pages/Onboarding.tsx`) — email/password sign-in → org pick → name → `edge-workstation-register` → mode-0600 secret write → agent auto-start. Raw secret shown once, never surfaced to the renderer after the enrolment moment.
- **Dashboard** (`src/pages/Dashboard.tsx`) — agent-process pill (running/stopped/pid) + relay-heartbeat freshness pill (fresh if `last_seen_at < 120 s`), 10 s poll of `public.workstations`, start/stop/restart controls.
- **Devices** (`src/pages/Devices.tsx`) — live table of `public.workstation_devices` (Phase 3 capability model): name, role, transport, driver, capabilities, health pill, last seen. 15 s poll.
- **Diagnostics** (`src/pages/Diagnostics.tsx`) — self-test suite covering workstation.json readability, agent process liveness, Supabase reachability. Wired for capability-gated device probes in Phase 4.2.
- **Logs** (`src/pages/Logs.tsx`) — tails the agent `/status` ring buffer with a JSON support-bundle download.
- **Auth** (`src/pages/Auth.tsx`) — displays workstation/org IDs, rotates the credential via the new `edge-workstation-rotate-secret` function, atomic re-write of `workstation.json`, agent restart. "Sign out workstation" clears `workstation.json` and returns to the enrolment wizard.
- **Server side**: new edge function `edge-workstation-rotate-secret` (deployed, org-membership authed against the workstation's `organization_id`) and migration adding `workstations.secret_rotated_at` for audit.
- Zero-dependency Supabase client (`src/lib/supabase.ts`) — no `@supabase/supabase-js` in the installer surface; auth/edge-invoke/PostgREST via `fetch`. Session held in-memory only; disk credential is the workstation secret at mode 0600.

Deferred to **Phase 4.2** (explicit "Coming next" section rendered inside Diagnostics so the scope is visible to the operator):
- Local TLS on the loopback listener + OS trust-store install from a signed installer.
- SSE tail for live log streaming (replaces the current on-demand `/status` pull).
- Supabase Realtime subscriptions for Dashboard/Devices (replaces 10-15 s polls).
- Real device probes (test page, cash-drawer kick, scale read, USB tree) wired through the loopback API.
- Signed installers (EV cert on Windows, notarization on macOS, apt/dnf repos on Linux) + `electron-updater` staged rollout channel.

### ⏳ Phase 5 — Plugin drivers
Split ESC/POS, ZPL, USB, biometric into `packages/edge-drivers-*` behind a `probe/open/execute/close/healthcheck` interface. Signed plugin loader in `~/.accrualflow/edge/plugins/`.

### ⏳ Phase 6 — Observability + Admin
OpenTelemetry hooks; Sentry-compatible crash reporter; admin console page (workstations list, versions, health, revoke, staged update rollout).


## 6. Technical Details (dev-facing)

- **Repo layout target**:
  ```
  edge/
    packages/runtime/          (ex agent/src, plus relay client)
    packages/desktop/          (Electron shell — Phase 4.1 shipped)
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
- **Loopback TLS**: per-install cert generated by installer via `mkcert`-equivalent bundled tool, installed into OS trust store; cert pinned in the ERP client after enrolment. **(Phase 4.2)**
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

**Currently active:** 🚧 **Phase 4.2 — Desktop shell hardening.** The Phase 4.1 scaffold is production-shaped but its transports and installer are still dev-grade. Do NOT jump to Phase 5 (drivers) or Phase 6 (admin) until 4.2 is closed — the plugin bus depends on the local-TLS loopback and the admin console depends on the observability hooks that land in 4.2.

**Before writing new code, verify Phase 4.1 is enterprise-grade complete:**

1. **Enrolment wizard end-to-end** — In `packages/desktop`, `npm install && npm run build && EDGE_DESKTOP_DEV_URL=http://localhost:5180 npm start`. Confirm (a) sign-in fails cleanly on bad creds without leaking session state, (b) org list is only populated when the user actually belongs to organizations (RPC `get_user_organizations`), (c) `workstation.json` is created at mode `0600` (`stat -c '%a' ~/.accrualflow/edge/workstation.json` = `600` on Linux, ACL equivalent on Windows), (d) the raw secret is never written to `localStorage`, `sessionStorage`, or IndexedDB (`localStorage.length === 0` in DevTools).
2. **IPC surface is minimal** — `window.edge` exposes only workstation / settings / agent / shell namespaces. Confirm the renderer cannot reach `require`, `process`, `fs`, `child_process`. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in `electron/main.cjs`.
3. **Rotate credential** — `edge-workstation-rotate-secret` invalidates the previous secret atomically. Verify by (a) rotating, (b) trying to `edge-agent-poll` with the old secret → expect 401, (c) confirming the new secret works. `secret_rotated_at` should update.
4. **Dashboard / Devices data paths** — Both are 10-15 s polls against PostgREST with `apikey`/`Authorization` headers correctly set for RLS. When the user is unauthenticated in the desktop app (fresh install after enrolment), those reads should still succeed via the workstation-level RLS on `public.workstations` and `public.workstation_devices` — verify this against the migration in `supabase/migrations/`.
5. **No orphaned surface in the web app** — `packages/desktop/` is intentionally NOT wired into `src/`. Nothing under `src/pages/` renders workstation identity or devices. That work is owned by the Electron shell; do not add ad-hoc routes for it.

**Once verification is green, start Phase 4.2 — Desktop shell hardening**, in this order (each unlocks the next):

1. **Local TLS on the loopback listener.** Extend `agent/src/server.ts` to bind `https://127.0.0.1:8443` with a per-install cert generated during first-run enrolment. Ship a small `edge-cert-install` helper (Windows: CertUtil; macOS: `security add-trusted-cert`; Linux: user-scoped NSS DB) that the desktop shell invokes from `electron/main.cjs` on first launch after enrolment. Pin the cert fingerprint in `workstation.json`.
2. **Realtime subscriptions in the shell.** Replace the 10-15 s polls in `Dashboard` and `Devices` with Supabase Realtime channels (`public.workstations`, `public.workstation_devices`). Fall back to poll on ws failure. Both tables already have Realtime enabled (Phases 2/3).
3. **SSE log tail.** Add a `GET /logs/stream` route to the agent that emits NDJSON via SSE from the same ring buffer surfaced by `/status`. Replace the current on-demand fetch in `packages/desktop/src/pages/Logs.tsx`.
4. **Real device probes in Diagnostics.** Wire capability-gated buttons for printer test page, drawer kick, scale read, USB tree — all through the (now-TLS) loopback API. Use `CapabilityResolver` from Phase 3 to enable/disable each button based on the current manifest.
5. **Signed installers + auto-update.** `electron-updater` on a versioned channel; EV cert on Windows, notarization on macOS, apt/dnf repos on Linux. Package via `@electron/packager` (per sandbox constraint — `electron-builder` is not usable here).

Only after all five 4.2 milestones land, move on to Phase 5 (plugin drivers). The plugin bus's `open()` method depends on a stable loopback URL + trusted TLS.


**Do not** jump ahead to Phase 5 (plugin drivers) or Phase 6 (observability) — the desktop shell is the operator-visible surface the plan promised and everything downstream assumes it exists.
