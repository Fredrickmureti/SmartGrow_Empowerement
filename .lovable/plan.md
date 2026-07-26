
# AccrualFlow Edge — Verification & Continuation Plan

## Progress log — Phase 4.2 (this pass)

Agent bumped to `v1.4.0-edge.p4.2.6`. Typecheck (`bunx tsgo --project agent/tsconfig.json` and `bunx tsgo --project packages/desktop/tsconfig.json`) is clean on all new/edited files; the only remaining diagnostics are the pre-existing errors in `agent/src/routes/biometric.test.ts`, `packages/desktop/src/lib/config.ts`, and `packages/desktop/src/main.tsx` (unrelated to this pass). Runtime end-to-end verification still needs an enrolled workstation on a developer machine.

**Currently active:** Phase 4.2 — items 4.2.1–4.2.6 shipped. **Next up:** 4.2.7 (Cert rotation + trust-store install helper).

Shipped:
- **4.2.6 Service supervisor (Windows / macOS / Linux)** — `agent/src/supervisor.ts` opens a platform-native IPC channel (named pipe `\\.\pipe\accrualflow-edge` on Windows, unix socket `~/.accrualflow/edge/supervisor.sock` mode 0600 on POSIX). Auth via `~/.accrualflow/edge/supervisor.token` (32-byte hex, mode 0600, generated on first boot, `crypto.timingSafeEqual` compare). Ops: `ping`, `status` (returns version/pid/uptime/tls/workstation), `reload_origins` (invokes new `refreshOriginsOnce()` in `agent/src/origins.ts`), `shutdown`. Cross-platform installer at `agent/scripts/install-service.cjs` with `install|uninstall|start|stop|status`: Windows uses `node-windows` (soft-required so non-Windows installs don't pull in win-only build tooling); macOS writes `~/Library/LaunchAgents/com.accrualflow.edge.plist` and `launchctl load -w`; Linux writes `~/.config/systemd/user/accrualflow-edge.service` and `systemctl --user enable --now`. Electron client at `packages/desktop/electron/supervisor-client.cjs` (single-shot NDJSON send with 3s timeout, no token exposure to the renderer). `main.cjs` adds `supervisor:{status,ping,reload,shutdown,install,uninstall,start,stop}` IPC; preload + `types.d.ts` extend `window.edge.supervisor`. Dashboard grows a "Service supervisor" panel with live status pill (online/offline + uptime + version + platform) and install/start/stop/reload/uninstall controls. Wired into agent lifecycle: started after origins, stopped on SIGINT/SIGTERM.
- **4.2.5 Tenant origin allowlist** — migration `2026-07-26` adds `organizations.edge_allowed_origins text[]` (default `{}`). New edge function `supabase/functions/edge-workstation-origins/index.ts` authenticates via the same workstation-secret pattern as manifest (SHA-256 compared to `workstations.secret_hash`), validates each origin URL (http/https, no path/query/fragment, ≤253 chars, cap 64), and returns `{ origins, ttl_seconds: 900, version: sha256(origins), fetched_at }`. Deployed and smoke-tested (unknown workstation returns 404 as expected). Agent side: `agent/src/origins.ts` fetches on start + every 15 min (60 s retry on error), caches to `~/.accrualflow/edge/origins.json` (mode 0644, no secrets), and exposes `getAllowedOrigins()` which merges built-in defaults + `AGENT_ALLOWED_ORIGINS` env override + tenant list. `agent/src/server.ts` no longer holds a hard-coded `ALLOWED_ORIGINS`; every CORS response reads the live snapshot. `SIGINT`/`SIGTERM` stops the refresh loop cleanly.
- **4.2.4 Device probes in Diagnostics** — new `POST /probe` on the agent (`agent/src/routes/probe.ts`) dispatches `printer.test_page` (ESC/POS test slip), `drawer.kick` (ESC p 0 pulse), `network.ping`, and `usb.list` against network or USB targets with a 5 s per-(deviceId, op) server-side cooldown that returns 429 + cached result on repeat clicks. Bearer injection moved to `main.cjs` (`agent:probe` IPC reads `~/.pos-agent-token` and proxies to loopback with an 8 s timeout) so the token never enters the renderer. Diagnostics page now lists live `workstation_devices` rows with role-appropriate buttons and per-device last-result feedback.
- **4.2.1 Local TLS on loopback** — `agent/src/tls.ts` load-or-generate per-install RSA-2048 self-signed cert at `~/.accrualflow/edge/tls/{cert.pem,key.pem,meta.json}`; SHA-256 fingerprint recorded and re-derived on load; SANs cover `localhost`+`127.0.0.1`+`::1`; auto-regenerate <30 d from expiry. New listener at `https://127.0.0.1:8443` alongside legacy `http://127.0.0.1:8043` (`AGENT_TLS_DISABLED=1` opts out). New unauthenticated `GET /tls-info` (fingerprint + port + expiry) and `/health` includes TLS metadata so the ERP can pin without a bearer.
- **4.2.2 Realtime subscriptions** — `packages/desktop/src/lib/realtime.ts` is a zero-dep Phoenix v2 client over `WebSocket` with `postgres_changes`, 25 s heartbeat, 3 s reconnect backoff. Dashboard subscribes to `workstations` UPDATE (30 s poll safety net); Devices subscribes to `workstation_devices` `*` (45 s safety net).
- **4.2.3 SSE log tail** — `GET /logs/stream` on the agent: auth + Host pin + Origin allowlist + 3-stream cap + 15 s heartbeat. `logger.ts` grew `subscribeLogs()` fan-out. `Logs.tsx` swapped to `EventSource` with auto-reconnect and a Live/Reconnecting pill; support-bundle download preserved.
- **Dashboard TLS surface** — "Local loopback" stat polls `/tls-info` and shows the live `https://127.0.0.1:8443` URL plus fingerprint.

Deferred to the next loop (nothing user-visible in the ERP yet):
- **4.2.7** Trust-store install helper + cert-rotation-on-secret-rotation. Only after this lands should `AgentClient` prefer `https:8443` in the browser (self-signed today fails WebCrypto validation).
- **4.2.8** Signed installers + `electron-updater` with staged rollout.
- **4.2.9** Daily `pg_cron` on `edge_jobs_expire_stale()`.

## Handoff — Instructions for the next agent

Before writing any new code, **verify 4.2.6 against enterprise-grade practice on a real workstation** (the sandbox can't spawn a service manager):

1. `bunx tsgo --project agent/tsconfig.json` and `bunx tsgo --project packages/desktop/tsconfig.json` — must be clean apart from the three pre-existing diagnostics called out at the top of this file.
2. Grep to confirm no supervisor token or workstation secret leaks into the renderer: `rg -n "supervisor.token|workstation_secret" packages/desktop/src` must return **zero** hits.
3. Start the runtime once from source (`cd agent && npx tsx src/index.ts`) and confirm:
   - `~/.accrualflow/edge/supervisor.token` exists, mode 0600, 64 hex chars.
   - POSIX: `~/.accrualflow/edge/supervisor.sock` exists, mode 0600, and `echo '{"op":"ping","token":"<tok>"}' | nc -U <sock>` returns `{"ok":true,"pong":…}`.
   - Windows: `Test-Path \\.\pipe\accrualflow-edge` is `True`.
4. From the tray app: Dashboard → Service supervisor should show `online · pid …` with uptime ticking, and `Reload origins` should return `ok`. An unauthorized client (wrong token) must get `unauthorized` — verify by hand with `nc`.
5. Install as service:
   - Windows: `node agent/scripts/install-service.cjs install`; confirm `sc query AccrualFlowEdge` shows `RUNNING`; reboot; confirm the service auto-starts and the tray app reports `online`.
   - macOS: same script; confirm `launchctl list | grep com.accrualflow.edge` and reboot survival.
   - Linux: same; confirm `systemctl --user is-enabled accrualflow-edge` and reboot survival.
6. Confirm graceful shutdown: `Uninstall` button removes the plist/unit/service and the socket file, and no zombie node process is left behind (`ps -ef | grep accrualflow` empty).

**Then resume at 4.2.7 (Cert rotation + trust-store install helper)** — do not skip ahead to 4.2.8 (signed installers) until 4.2.7 lands, because signed installers depend on the trust-store helper for the loopback cert flow. Sequencing rule for 4.2.7:
  a. Extend `agent/src/tls.ts` to expose a `rotateLoopbackTls()` that regenerates cert+key and updates the fingerprint on disk.
  b. Add `edge-workstation-rotate-secret` handling: after the secret is rotated, the agent regenerates the cert on next boot and republishes the fingerprint in the manifest.
  c. Add per-OS trust-store helpers (`certutil -addstore -f Root cert.pem` on Windows, `security add-trusted-cert -k …` on macOS, `update-ca-trust` / user NSS DB on Linux) invoked from a new IPC `supervisor:install_cert` so operators can trust the cert once, without leaving the tray app.
  d. Only after (a)–(c) land should `AgentClient` prefer `https:8443` — today the self-signed cert fails WebCrypto validation and the ERP would fall back anyway.

## Verification of Prior Work (Phase 1)

Before writing new code, confirm what the previous engineer marked ✅ in `.lovable/plan.md` is real:

- **Phase 1 (hardened agent):** confirm in `agent/src/server.ts` — loopback bind, Host-header pin, `Access-Control-Allow-Private-Network`, tightened Origin allowlist, `X-Edge-Nonce` on mutating routes (`agent/src/nonce.ts` + wired in `routes/print.ts|test.ts|usb.ts`), NDJSON logger + ring buffer (`agent/src/logger.ts`), `/health` and `/support-bundle` (`agent/src/routes/health.ts|support.ts`).
- **Phase 2 (relay):** confirm migration `20260726020046_*.sql` creates `workstations` + `edge_jobs` with Realtime/RLS/GRANTs; edge functions `edge-workstation-register`, `edge-agent-poll`, `edge-agent-complete` exist and enforce workstation-secret auth; `agent/src/relay.ts` polls and dispatches; `AgentClient` prefers relay for `printNetwork`/`testConnection`/`printUsb`.
- **Phase 3 (capability model):** confirm `workstation_devices` + `workstation_manifests` migration, `edge-workstation-manifest` function, `agent/src/manifest.ts` publisher wired in `agent/src/index.ts`, and `src/services/hardware/local-agent/CapabilityResolver.ts`.
- **Phase 4.1 (desktop shell):** confirm `packages/desktop/` scaffold — `.cjs` main, `base: './'`, mode-0600 `workstation.json` write, sandboxed preload, all six pages (Onboarding, Dashboard, Devices, Diagnostics, Logs, Auth), `edge-workstation-rotate-secret` function + `secret_rotated_at` column, in-memory-only Supabase session.

For each ✅ item, verify: file exists, exports are wired, contract matches the plan, and no regressions (typecheck clean via `bunx tsgo`). Anything that fails verification is demoted to pending and folded into Phase 4.2's start.

Deliverable of verification pass: a short delta note in `.lovable/plan.md` under Phase 4.1 listing anything that failed to verify, so the record stays honest.

## Gaps / Additions to the Existing Plan

Reviewing against enterprise practice, add these to the roadmap before Phase 5:

1. **Cert lifecycle** — per-install loopback cert must have rotation (yearly) and revocation-on-rotate-secret; store fingerprint in `workstation.json` and pin in `AgentClient`. Not in the current 4.2 list.
2. **Origin allowlist source of truth** — the loopback listener currently hard-codes origins in `agent/src/server.ts`. Move to a tenant-signed allowlist fetched at enrolment and cached in `workstation.json`, so custom domains work without code changes.
3. **Agent supervision on Windows** — the current tray-app-spawns-child model dies with the user session. Add a Phase 4.2 subtask to install a Windows Service (auto-start) that hosts the runtime, with the tray app as a client of it.
4. **Job idempotency ceiling** — `edge_jobs` needs periodic purge (14 d) via `edge_jobs_expire_stale` scheduled via `pg_cron`; verify the schedule exists, add it if missing.
5. **Loopback SSE auth** — `/logs/stream` must reuse the bearer token + Origin allowlist and cap concurrent streams; add to the SSE subtask.
6. **Probe safety** — real device probes (Diagnostics) must be idempotency-keyed and rate-limited per role so a stuck operator can't spam a drawer kick.

These are appended to Phase 4.2 below, not deferred.

## Phase 4.2 — Desktop Shell Hardening (execution order)

Each step unlocks the next. Land, verify, then move on.

1. **Local TLS on loopback (`https://127.0.0.1:8443`)**
   - Generate per-install RSA-2048 cert + key at first-run enrolment inside `electron/main.cjs` (via bundled `node-forge` — no external CLI).
   - Write cert to `~/.accrualflow/edge/cert.pem` (mode 0644) and key to `key.pem` (mode 0600); record SHA-256 fingerprint in `workstation.json`.
   - Extend `agent/src/server.ts` to bind an `https.createServer` on 8443 in addition to (temporarily) 8043; add `--tls-only` flag flipped by the installer once ERP client is confirmed cutover.
   - Ship `edge-cert-install` helper module invoked from `main.cjs` per OS (CertUtil / `security add-trusted-cert` / user NSS DB).
   - `AgentClient` pins the fingerprint from the workstation record and prefers `https://127.0.0.1:8443` when reachable.

2. **Realtime subscriptions in the shell**
   - Replace 10-15 s polls in `Dashboard.tsx` and `Devices.tsx` with Supabase Realtime channels on `public.workstations` and `public.workstation_devices` (both already Realtime-enabled).
   - Reconnect with exponential backoff; fall back to poll on ws failure > 30 s.

3. **SSE log tail**
   - Add `GET /logs/stream` to the agent (auth + Origin allowlist + max 3 concurrent streams) emitting NDJSON from the existing ring buffer.
   - Replace `packages/desktop/src/pages/Logs.tsx` on-demand fetch with SSE subscription; retain download-support-bundle button.

4. **Real device probes in Diagnostics**
   - Wire buttons: receipt test page, drawer kick, scale read, USB tree, biometric ping.
   - Each button gated by `CapabilityResolver` against current manifest; disabled when no matching device.
   - Every probe carries an idempotency key and a client-side 5 s rate-limit per role.

5. **Origin allowlist from server**
   - Add `edge-workstation-origins` edge function returning the tenant's signed allowlist.
   - Agent fetches at start (and every 15 min) via workstation secret; caches to `workstation.json`.

6. **Windows Service supervisor**
   - Package a small Rust/Go or `node-windows`-based service that hosts the runtime; tray app talks to it via named pipe.
   - macOS: LaunchAgent plist; Linux: systemd user unit. Auto-start on boot.

7. **Cert rotation + revocation**
   - `edge-workstation-rotate-secret` also rotates the loopback cert fingerprint field; agent regenerates cert and re-invokes trust-store install.

8. **Signed installers + auto-update**
   - `@electron/packager` outputs; sign Windows with EV cert (via `CSC_LINK`), notarize macOS (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`), publish deb/rpm to a tenant repo.
   - `electron-updater` on a versioned channel with staged rollout (10 → 50 → 100 %).

9. **`edge_jobs` purge schedule**
   - Migration adding `pg_cron` job `edge_jobs_purge_stale` running `edge_jobs_expire_stale()` daily.

Verification for Phase 4.2 close: an enrolled workstation prints, scans, kicks a drawer, and reads a scale from `https://www.accrualflow.systems` end-to-end without console warnings, without an HTTP-on-HTTPS caveat, and survives a workstation reboot.

## Phase 5 (Plugin Drivers) and Phase 6 (Observability + Admin)

Unchanged from `.lovable/plan.md`. Do not begin until Phase 4.2 items 1–4 (minimum) are live in preview; items 5–9 can land in parallel with Phase 5.

## Working Rules

- Preserve the ✅ Phase 0-3 contracts. `AgentClient` stays the single browser chokepoint; only its internals change.
- Every migration includes GRANTs (per project guardrails).
- No new `src/` code touching `window.pos.{usb,serial,hid}` — everything through `hardwareClient`.
- Update `.lovable/plan.md` after each subtask lands (mark 🚧 → ✅ with the verifying command).
