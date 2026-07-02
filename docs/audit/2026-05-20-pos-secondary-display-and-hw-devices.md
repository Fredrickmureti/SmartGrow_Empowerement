# POS Secondary Display + Hardware Devices — Audit & Fix

_Date: 2026-05-20_

## Issue 1 — Secondary / customer display "does not launch"

### Observed
Operators clicking the "Display" toggle in `POSTerminal` see nothing
happen, both in Electron and in the browser/PWA preview.

### Root cause(s)
1. **Electron single-monitor regression.** `customer-display:open`
   accepted `displayIndex = 1` by default. On a single-monitor box
   `screen.getAllDisplays()[1]` is `undefined`; the code fell back to
   the last (= primary) display and opened a `BrowserWindow` with
   `fullscreen: true, alwaysOnTop: true, frame: false` on top of the
   cashier UI. Operators perceived this as "the app froze" and
   Alt+Tabbed away, so they never saw the secondary screen.
2. **Browser popup blocker swallowed silently.** `window.open(...)` was
   called from the hook but a `null` return was reported as an empty
   `"Failed to open display window"` string and never surfaced to the
   operator.
3. **Popup reload loses opener channel.** `postMessage` from the
   cashier window is keyed to the live `Window` reference. If the
   secondary popup is reloaded (or a stale handle is held), updates
   silently stop.

### Fix
- `electron/main.ts` — clamp `displayIndex` to the available range, force
  windowed (and drop `alwaysOnTop`) whenever the resolved target is the
  primary display, await the prior window's `closed` event before
  replacing the singleton, and reap the singleton on `render-process-gone`.
- `CustomerDisplayClient.open()` — pre-clamp index and intent against
  the live `getDisplays()` list, surface "Pop-up blocked" as the error
  string in the browser fallback.
- `CustomerDisplayClient.update()` — broadcast via
  `BroadcastChannel('pos:customer-display')` alongside `postMessage` so
  popup reloads automatically re-attach.
- `CustomerDisplay.tsx` — subscribe to the same `BroadcastChannel`.
- `useCustomerDisplay.open` — toast `"Single display detected …"` so
  the operator understands why the popup is small/windowed.

### Residual risks
- BroadcastChannel is unavailable in some embedded webviews; `postMessage`
  remains as a fallback.
- Cross-OS multi-monitor combinations cannot be matrixed in CI; behaviour
  is guarded by clamp + downgrade rules at both ends of the IPC.

## Issue 2 — `/pos/hardware-devices` blank white page in Electron

### Observed
In the packaged Electron build only, navigating to
`/pos/hardware-devices` rendered nothing — no header, no spinner, no
error UI. Other POS workspace routes worked.

### Root cause framework
The POS workspace shell wrapped sub-routes only in a `<Suspense>`. There
was no error boundary between `POSShellLayout` and the lazy pages, so:
- a thrown error during chunk evaluation or first render bubbled all the
  way up to the root `SentryErrorBoundary` which white-screens, AND
- the existing `POSErrorBoundary` keeps re-rendering its children even
  after a render throw, which means a faulty subtree throws on every
  commit until React tears the whole tree down to bare DOM.

### Fix
- New `src/components/pos/POSShellErrorBoundary.tsx` — proper boundary
  that STOPS rendering the throwing subtree, prints the error name +
  message + component stack in a visible card, and exposes Reset / Reload.
- `POSShellLayout` now wraps the outlet in this boundary, keyed on the
  POS sub-route so navigating away resets the boundary.
- New `resilientLazy()` in `src/apps/pos/routes.tsx` converts a failed
  dynamic `import()` into an inline "X failed to load" card. Wired
  around `HardwareDevices` first; can be applied to the other lazy POS
  imports once we have telemetry indicating they need it.

These two changes turn the previously opaque white screen into an
actionable diagnostic. Once a customer hits the real underlying error
(chunk load vs evaluation throw vs runtime exception inside
`hardwareClient`) we will see the message in the in-app card and in
`console.error('[pos-shell] render error', …)` instead of having to
guess.

### Residual risks
- The underlying error in any individual deployment still has to be
  fixed; the boundary makes it visible, it does not paper over it.
- `resilientLazy` is applied only to `HardwareDevices` to limit blast
  radius. Expand to all POS lazy routes once verified.

## Architecture invariants reinforced

1. Every POS workspace route must render through `POSShellErrorBoundary`.
   Tests asserting this should be added in a follow-up wave (see plan).
2. Customer-display IPC must clamp `displayIndex` at both ends of the
   IPC; renderer-side hooks may not assume index validity.
3. Customer-display fan-out uses BroadcastChannel as the primary
   transport in the browser; `postMessage` is a fallback only.