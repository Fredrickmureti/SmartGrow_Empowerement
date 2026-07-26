## Verification findings (Phase 1 — done, evidence-based)

I audited `.lovable/plan.md` against the codebase. What the previous engineer claimed for 4.2.1–4.2.6 is, at the file level, real:

- `agent/src/tls.ts` — per-install self-signed loopback cert, SANs for `localhost`/`127.0.0.1`/`::1`, 0600 key, 30-day expiry check. Present.
- `agent/src/server.ts` — `/tls-info` is one of exactly three unauthenticated routes; TLS port 8443 read from env. Present.
- `agent/src/supervisor.ts` — IPC with `ping` / `status` / `reload_origins` / `shutdown`. Present.
- `agent/scripts/install-service.cjs`, `agent/src/origins.ts`, `agent/src/routes/probe.ts`, `agent/src/routes/logs-stream.ts`, `packages/desktop/src/lib/realtime.ts`, all six desktop pages, and the six `supabase/functions/edge-*` functions all exist.
- Renderer leak check: no supervisor token or workstation secret is read in `packages/desktop/src` beyond the enrolment write path (`Onboarding.tsx`, `Auth.tsx` pass `workstation_secret` straight to the main-process IPC write, which is the intended flow).

**Gaps found — 4.2.7 is materially unstarted, not "next up with (a) done":**

1. `rotateLoopbackTls()` is exported from `agent/src/tls.ts` but has **zero call sites anywhere in the repo**. It is dead code, so item (a) is not genuinely complete.
2. There are **no trust-store helpers at all** — no `certutil`, `security add-trusted-cert`, or `update-ca-trust` anywhere, and no `supervisor:install_cert` IPC op.
3. `edge-workstation-rotate-secret` updates `secret_hash` + `secret_rotated_at` only; it does not signal cert rotation, and `agent/src/manifest.ts` publishes no `tls` / fingerprint field, so the ERP has nothing to pin against.
4. `AgentClient` still only ever talks to `this._baseUrl` (plaintext loopback) with the relay as the preferred path — correct for today, but it is the thing 4.2.7(d) is meant to unblock.
5. No `pg_cron` schedule for `edge_jobs_expire_stale()` (4.2.9 confirmed pending).

So: resume at a genuine 4.2.7 start, not mid-item.

## Work to do

### 4.2.7a — Make cert rotation real
- Add a rotation trigger in `agent/src/tls.ts`: persist `secretRotatedAt` in `meta.json`; add `ensureLoopbackTls({ rotateIfBefore })` that regenerates when the recorded rotation stamp is older than the workstation's `secret_rotated_at`.
- Call it from `agent/src/index.ts` on boot, using the value the manifest publisher already fetches. `rotateLoopbackTls()` stops being dead code.
- Expose `supervisor: rotate_cert` so the tray app can force rotation without a restart; the HTTPS listener rebinds with the new context.

### 4.2.7b — Publish the fingerprint to the ERP
- Extend `agent/src/manifest.ts` to include `tls: { enabled, fingerprint_sha256, port, generated_at }` in the published manifest.
- Extend `supabase/functions/edge-workstation-manifest` to accept and persist it on `workstation_manifests`.
- Migration: add the column if the manifest is stored in typed columns rather than JSONB (GRANTs included, per project rules).

### 4.2.7c — OS trust-store install helper
- New `agent/src/trustStore.ts` with per-platform install/uninstall:
  - Windows: `certutil -addstore -f Root cert.pem` (elevation prompt handled, non-zero exit surfaced).
  - macOS: `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain`.
  - Linux: copy to `/usr/local/share/ca-certificates/` + `update-ca-trust` / `update-ca-certificates`, plus user NSS DB (`certutil -d sql:$HOME/.pki/nssdb -A`) for Chrome.
- Wire as supervisor ops `install_cert` / `uninstall_cert`, `main.cjs` IPC `supervisor:installCert`, preload + `types.d.ts`, and a "Trust local certificate" control with live trusted/untrusted state on the Dashboard TLS panel.
- Never run these implicitly — always an explicit operator action, with the exact command shown before it runs.

### 4.2.7d — Let the browser prefer HTTPS loopback
- `AgentClient` gains transport preference: probe `https://127.0.0.1:8443/tls-info`, and on success use HTTPS as the direct-loopback transport; on TLS failure fall back to the relay (never silently to plaintext from an HTTPS origin).
- Cache the probe result per session; keep the relay as the default when neither loopback works.

### 4.2.7c UI — done
- `packages/desktop/src/components/CertificatePanel.tsx` on the Dashboard: live trusted/untrusted/unknown state from `cert_status`, "Review commands" showing the exact argv (and which steps elevate) before anything runs, plus Rotate / Trust / Remove-trust actions and per-step result output. Nothing runs on mount except the read-only status query.

### 4.2.8 — Signed installers + update channel (done, credentials pending)
- `packages/desktop/scripts/build-installers.mjs` (`npm run package:signed`): `@electron/packager` build per target, Windows signing via `CSC_LINK` / `CSC_KEY_PASSWORD`, macOS signing via `CSC_NAME` and notarization via `APPLE_ID` / `APPLE_APP_PASSWORD` / `APPLE_TEAM_ID`. Missing credentials produce an UNSIGNED artifact plus an explicit warning naming the variable — no invented values. Emits archives + a `stable.json` channel manifest with per-artifact SHA-256.
- `packages/desktop/electron/updater.cjs`: read-only channel check with numeric version compare, deterministic per-install rollout bucket (sha256 of workstation id), and `minimum_version` override for mandatory updates. It never downloads or executes an installer.
  - Deviation from the original plan: `electron-updater` is not used. Our artifacts come from `@electron/packager`, so there is no electron-builder `latest.yml` for it to consume; the operator applies the update explicitly from the verified download link.
- IPC `updates:check` in `main.cjs`, `window.edge.updates.check()` in preload + `types.d.ts`, and an "Updates" panel on the Dashboard showing installed→latest, channel, rollout %, bucket, notes and artifact SHA-256.
- Tests: `src/test/hardware/update-channel.test.ts` pins version ordering and rollout-bucket stability/spread.

**Build secrets you must add before shipping signed builds:** `CSC_LINK`, `CSC_KEY_PASSWORD`, `CSC_NAME`, `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`, and `EDGE_UPDATE_BASE_URL` / `EDGE_UPDATE_URL` for the channel host.

### 4.2.9 — `edge_jobs` purge schedule (done)
- `pg_cron` job `edge_jobs_purge_stale` runs `edge_jobs_expire_stale()` daily.

### Plan hygiene
- Rewrite `.lovable/plan.md` to reflect the verified state above (4.2.7 reset to not-started with the four sub-items), so the next engineer inherits an accurate log rather than an optimistic one.

## Technical notes

Sandbox limits: I cannot spawn a service manager, install into an OS trust store, or run an enrolled workstation end-to-end here. Everything above will be verified by typecheck (`bunx tsgo --project agent/tsconfig.json`, `--project packages/desktop/tsconfig.json`), targeted unit tests for the pure pieces (fingerprint derivation, rotation-decision logic, trust-store command construction per platform), and static wiring checks. The manual on-machine verification checklist stays in `plan.md` for the steps that genuinely require a real workstation.
