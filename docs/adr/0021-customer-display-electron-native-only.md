# ADR-0021: Customer display — Electron-native only, never browser-popup fallback

Date: 2026-06-07
Status: Accepted
Relates to: ADR-0014 (main-process orchestrator), ADR-0015 (Electron-safe document preview)

## Context

The cashier-side toast "Pop-up blocked. Allow pop-ups for this site to
open the customer display." was reported from inside the packaged
Electron POS — a context where browser popup policy is not supposed to
apply at all. Audit found that `CustomerDisplayClient.open()` branched
on `window.pos?.isElectron`; when that single signal was missing
(stale packaged binary, preload-throw, sandbox quirk) the renderer
silently fell through to `window.open()` inside Electron, and the
resulting null return surfaced as the misleading "pop-up blocked"
toast.

## Decision

1. The renderer treats itself as "inside Electron" whenever ANY of
   these signals is true: `window.pos.isElectron === true`, UA
   contains ` Electron/`, or `window.pos.app.customerDisplay.open` is
   a function.
2. Inside Electron, if the `customerDisplay` IPC surface is not fully
   attached (`open`, `close`, `update`, `getDisplays`, `isOpen`), the
   renderer returns a typed `electron_preload_stale` (when `window.pos`
   exists but is partial) or `electron_preload_failed` (when
   `window.pos` is absent) result. It MUST NOT call `window.open()`.
3. On the genuine browser/PWA path, `window.open()` is invoked
   synchronously before any `await` so Chromium's transient user
   activation rule is honored.
4. `CustomerDisplayOpenResult.reason` is part of the public contract.
   UI surfaces reason-specific copy: `browser_popup_blocked`,
   `electron_preload_stale`, `electron_preload_failed`,
   `no_secondary_display`, `unknown`.
5. On cashier-side reload, `customerDisplay.rebindIfElectronWindowOpen()`
   re-attaches `isConnected` to a still-living secondary BrowserWindow
   and replays the last payload via IPC `update`.

## Consequences

- Misleading popup-block toasts inside Electron are no longer possible
  at this seam; the toast string now identifies the true cause.
- A stale desktop binary surfaces a self-diagnosing message that names
  `preloadBuild`, pointing operations at "reinstall the desktop app"
  rather than at browser popup permissions.
- Cashier reloads no longer leave the secondary display orphaned.
- Future work (deferred to a focused loop): preload-side
  `customerDisplayReady` boolean, `pos:preload-failed` IPC + main-side
  notification, and a Customer Display row on the
  `/platform/hardware/devices` Runtime card surfacing the preload
  fingerprint and live `isOpen()` result.