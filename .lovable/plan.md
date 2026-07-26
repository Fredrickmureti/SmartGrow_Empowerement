# AccrualFlow Edge Desktop — runtime supervision fixes

Three defects, all in `packages/desktop/electron/*` plus packaging. Verified by reading the code.

## 1. Agent never starts (auto or on "Start agent")

Confirmed causes in `electron/main.cjs`:

- `app.whenReady()` (line 355) only creates tray + window. **`startAgent()` is never called**, so nothing auto-starts.
- `startAgent()` (line 213) spawns with `stdio: 'ignore'` and returns `{ ok: true }` **immediately after spawn**, without waiting for a health probe. If the child dies a second later (missing deps, TS loader failure, port in use) the UI silently reports "not running" and there is no error anywhere.
- Launch resolution (`findAgentLaunch`, line 197) prefers `agent/dist/index.js`, which does not exist because the agent is never built; it then falls back to running `tsx src/index.ts` through `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, or to `npm run dev` (npm is not guaranteed to be on PATH of a GUI-launched app on Windows/macOS).
- `agentRoot()` resolves `../../../agent` relative to `electron/`. Inside a packaged app that path does not exist → `agent_not_bundled`.

### Fix

- Add a real supervisor in main: `startAgent()` spawns with piped stdio, records the last ~200 stderr/stdout lines in a ring buffer, then polls `/health` for up to ~15 s and only resolves `{ ok: true }` when the runtime answers. On failure it returns `{ ok: false, error, log }` so the Dashboard can show the actual reason.
- Add crash supervision: on unexpected child `exit`, restart with backoff (1s, 2s, 5s, 10s, cap 30s, max 5 in 60 s), surfacing state via `agent:status`.
- Auto-start on `app.whenReady()` (after `ensureEdgeHome`), unless settings has `agent_autostart: false` or a service supervisor already owns the runtime (health probe answers).
- Interpreter resolution, in order: packaged agent bundle → `agent/dist/index.js` with `ELECTRON_RUN_AS_NODE=1` → `agent/src/index.ts` via tsx → `npm run dev` last resort. Add a `prestart`/dev script so the agent is compiled (`npm --prefix agent run build`) before Electron launches, making the `dist` path the normal one.
- Expose the captured child log through `agent:logs` when the HTTP `/support-bundle` is unreachable, so a failed start is diagnosable in the Logs tab instead of VS Code.

## 2. Service supervisor: `installer_not_bundled`

`runInstaller()` (line 327) resolves `../../../agent/scripts/install-service.cjs`. That file exists in the repo but is absent from any packaged build, and the packaging scripts in `packages/desktop/package.json` never include the `agent/` tree.

### Fix

- Path resolution becomes `app.isPackaged ? path.join(process.resourcesPath, 'agent', 'scripts', 'install-service.cjs') : <repo path>`, with the dev path as fallback.
- Add `--extra-resource=../../agent` (and the same in `scripts/build-installers.mjs`) so the built runtime + installer ship inside the app, pruned to `dist/`, `scripts/`, `package.json`, and production `node_modules`.
- `runInstaller` also passes `ACCRUALFLOW_AGENT_ROOT` and returns `stderr` in the error message instead of a bare code, so "install failed" states the real reason (e.g. missing `node-windows` on Windows).
- After a successful `install`/`start`, main stops its own child agent to avoid two runtimes fighting over port 8043, and `supervisor:status` becomes the source of truth in the Dashboard.
- `supervisor_not_running` when no service is installed is expected; the Dashboard copy will distinguish "not installed" from "installed but down" using the installer's `status` subcommand.

## 3. Updates always "check failed"

`electron/updater.cjs` fetches `https://updates.accrualflow.app/edge/{channel}.json`, a host that does not serve a manifest, so every check ends in the `catch` branch.

### Fix

- Treat "no channel configured / manifest unreachable" as a distinct, non-error state: the panel shows "Update channel not configured" (or "Could not reach the update channel — retrying later") instead of "Check failed".
- Make the channel URL configurable from Settings (`update_channel_url`) and from `EDGE_UPDATE_URL`, defaulting to unset → the panel renders the current version and an explicit "not configured" note.
- Distinguish DNS/timeout, HTTP 404, and malformed manifest in the returned payload; `UpdatesPanel.tsx` renders each with the right tone and only shows a red failure for a configured-but-broken channel.

## Verification

- Build the agent, launch Electron from source: agent auto-starts, Dashboard shows Running with a PID, killing the child shows a restart.
- Force a failure (occupy port 8043): Start reports the real error and the child log is visible in Logs.
- Packaged linux build: `resources/agent` present; `supervisor:install` runs the installer and reports systemd output.
- Updates panel with no channel configured shows the "not configured" state, not "Check failed".

## Out of scope

No changes to the agent's HTTP contract, relay transport, TLS, or the web ERP.
