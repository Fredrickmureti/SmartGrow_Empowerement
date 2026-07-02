# Customer display "Pop-up blocked" — RCA and remediation (Wave 9f)

Date: 2026-06-07
ADR: 0021

## Symptom

Inside the packaged Electron POS, opening the customer secondary
display surfaced:

> Pop-up blocked. Allow pop-ups for this site to open the customer display.

The display never launched. This implied a browser popup API was
being invoked from inside Electron — architecturally wrong.

## Architecture in place (confirmed correct)

- `electron/main.ts` owns the secondary `BrowserWindow`
  (`customerDisplayWindow`), positioned via
  `screen.getAllDisplays()[displayIndex]`, with `render-process-gone`
  cleanup, `did-fail-load` logging, and a singleton lifecycle.
- `electron/preload.ts` exposes `window.pos.app.customerDisplay.{getDisplays,
  open, close, update, isOpen}` via `contextBridge` with
  `contextIsolation: true`, `nodeIntegration: false`.
- Updates flow through `customer-display:data` IPC and `pos:event`;
  the secondary route is `/pos/customer-display` loaded via hash in
  the packaged build.

## Root cause

`CustomerDisplayClient.open()` branched solely on
`window.pos?.isElectron`. When that single signal was missing — stale
packaged binary that pre-dates the `app` preload feature, or a
preload-throw that aborts `contextBridge.exposeInMainWorld` — the
renderer silently fell through to `window.open()` inside Electron. The
null return then surfaced as a misleading "pop-up blocked" toast.

The browser fallback path itself was also broken: it `await`-ed
`getDisplays()` before `window.open()`, so Chromium dropped transient
user activation and the popup was blocked even when permission was
granted.

## Fix

- `CustomerDisplayClient.isElectronEnvironment()` corroborates three
  signals (preload flag, UA, IPC binding presence).
- `isElectronBridgeReady()` requires all five `customerDisplay`
  bindings before the Electron path is taken.
- Electron + incomplete bridge → typed `electron_preload_stale`
  (or `electron_preload_failed` when `window.pos` is absent), with an
  error string that names `preloadBuild`. `window.open()` is never
  called inside Electron.
- Browser path calls `window.open()` synchronously before any `await`.
- `customerDisplay.rebindIfElectronWindowOpen()` is invoked from
  `ElectronHydratorMount` so a cashier-side reload reattaches to a
  still-living secondary window and replays the last payload.
- `CustomerDisplayOpenResult.reason` is now part of the contract so
  the UI can render reason-specific copy.

## Files touched

- `src/services/hardware/local-display/CustomerDisplayClient.ts`
- `src/services/hardware/HardwareClient.ts`
- `src/components/hardware/ElectronHydratorMount.tsx`
- `src/test/pos/customer-display-electron-detection.test.ts` (new)
- `docs/adr/0021-customer-display-electron-native-only.md` (new)

## Deferred (queued for a follow-up loop)

- Preload-side `customerDisplayReady` boolean and `pos:preload-failed`
  IPC, so main can surface a system notification and write
  `userData/preload-errors.log`.
- Customer Display row on the `/platform/hardware/devices` Runtime
  card: preload fingerprint, IPC bindings present, live `isOpen()`,
  last `open()` reason, available displays from
  `screen.getAllDisplays()`.
- UI toast-copy switch driven by `result.reason`, replacing the single
  string at call sites.
- Architecture guard: `src/test/architecture/no-window-open-in-electron-path.test.ts`.

## Test matrix (manual, packaged build)

| Scenario | Expected |
|---|---|
| Single monitor, Electron | `no_secondary_display` reason, windowed display on primary |
| Dual monitor, Electron | Secondary BrowserWindow on display index 1, fullscreen |
| Cashier reload while secondary open | `rebindIfElectronWindowOpen()` → secondary rehydrates with last payload |
| Secondary `render-process-gone` | Singleton cleared, next open succeeds |
| Deliberately corrupted preload | `electron_preload_failed` toast, never popup-block |
| Browser/PWA | `window.open()` synchronous, popup opens; if blocked → `browser_popup_blocked` toast |