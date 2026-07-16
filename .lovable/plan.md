## Goal

Deliver a robust detachable Live Preview for the Localization Publishing Editor that behaves as reliably as the POS secondary customer display. Fix the "404 – Page Not Found" the pop-out currently shows, and harden the detach / re-attach / lifecycle flow instead of masking the symptom.

## What I found

- Pop-out URL is built by `openPreviewWindow(kind, templateCode)` → `/localization/preview/{kind}/{templateCode}` (`src/features/localization/lib/previewBroadcast.ts`).
- The route file exists: `src/routes/localization.preview.$kind.$templateCode.tsx` with `createFileRoute("/localization/preview/$kind/$templateCode")`, lazy‑loading `LocalizationPreviewWindow`.
- The generated route tree does include it (`src/routeTree.gen.ts` → `LocalizationPreviewKindTemplateCodeRouteImport`).
- The literal "404 — Page Not Found" text the user sees is `defaultNotFoundComponent` in `src/router.tsx` (identical string in `__root.tsx`). So the router is falling through to not-found rather than the child window's document failing to load.
- This project is a hybrid: TanStack owns the shell + a few explicit routes; every unknown URL is caught by `src/routes/$.tsx` which mounts the legacy `<App/>` + `BrowserRouter` SPA. Since the preview route is a specific 4‑segment path it MUST win over `/$`, so the fact that 404 renders instead of `LocalizationPreviewWindow` points to a routing/build mismatch in the deployed preview build, not a runtime crash inside the component (an error would render `defaultErrorComponent`).
- Local dev sanity check returned `HTTP 500 {"unhandled":true,"message":"HTTPError"}` for every path (including `/`, `/scan/x`, `/localization/preview/certificate/x`) — the SSR handler is currently wedged in this sandbox, so live‑verification requires restarting Vite before I can rely on browser results.

## Fix plan

### 1. Restore verifiable ground truth
1. Restart the Vite dev server so SSR stops returning 500 for every request.
2. Drive Playwright against `http://localhost:8080/localization/preview/certificate/TEST` and confirm `LocalizationPreviewWindow` mounts (title "Localization preview", body shows the "Waiting for the editor…" empty state). This is the pipeline the pop-out relies on end-to-end.

### 2. Force route‑tree sync
Even though `src/routeTree.gen.ts` currently references the preview route, this is the single most common failure mode for the observed symptom (route file present, deployed bundle missing it). I will:
1. Touch `src/routes/localization.preview.$kind.$templateCode.tsx` to force the TanStack router Vite plugin to regenerate `routeTree.gen.ts`.
2. Re-open the URL in Playwright and confirm the specific route matches before `/$`.
3. Add a lightweight `console.info("[localization-preview] mounted", { kind, templateCode })` inside `LocalizationPreviewWindow` so future regressions are diagnosable from console logs (mirrors the `console.error('[pos-shell] render error', …)` pattern from the POS audit doc).

### 3. Harden the pop-out contract (mirror POS customer display invariants)
Apply the same three architectural invariants the POS audit locked in for the secondary display (`docs/audit/2026-05-20-pos-secondary-display-and-hw-devices.md`):

1. **Singleton window keyed by `(kind, templateCode)`**. `openPreviewWindow` already reuses `window.name`; add a module-level `Map<key, Window>` guard, and when the existing entry's `.closed` is true, replace it rather than silently returning a stale ref. Surface a toast when `window.open` returns `null` (pop-up blocker) instead of the current silent failure.
2. **Broadcast + storage fan-out is the primary transport**, `postMessage` is the fallback. `previewBroadcast.ts` already does this; I will:
   - Deduplicate the `BroadcastChannel` per key (currently `publishPreview` opens+closes a channel on every keystroke, which is wasteful and prevents `onmessage` echo detection).
   - Cap `localStorage` writes with a coalescing timer (~100 ms) so heavy editor typing doesn't hit quota / trigger `storage` events on every keystroke.
3. **Bidirectional lifecycle**:
   - Parent → child: on parent `beforeunload`, broadcast a `{type:"opener-closing"}` control message; child closes itself on receipt.
   - Child → parent: child broadcasts a `{type:"detached-alive"}` heartbeat every 2 s. Parent's detach hook uses `child.closed` polling AND heartbeat timeout to detect manual close, restoring the inline preview immediately in both cases (the current `AuthoringWorkspace` only polls `.closed`, which is unreliable when the OS suspends the tab).
   - Child polls `window.opener` and self-closes if the opener is gone (covers hard-crash of the parent tab).

### 4. Verify every acceptance criterion
Using Playwright against the dev server, script the following and screenshot each step:
1. Open a certificate editor, click Detach → new window opens and shows the current draft (no 404).
2. Edit a token in the editor → child window updates within one frame.
3. Inline preview column is hidden while detached; editor pane fills the freed width.
4. Status pill "Preview detached — live syncing" is visible with a working "Focus window" action.
5. Toolbar button reads "Re-attach preview"; clicking it closes the child and restores the inline preview.
6. Manually close the child window → parent restores inline preview automatically (within ~2 s).
7. Close the parent tab → child auto-closes (verified via a second Playwright context observing the child).
8. Click Detach twice in a row → second click focuses the existing window (no duplicate).
9. Repeat steps 1‑3 for `return` and `bank-export` editors to prove the shared workspace wiring is generic.

## Technical section

- Files touched (edit only): `src/features/localization/lib/previewBroadcast.ts`, `src/features/localization/components/LocalizationPreviewWindow.tsx`, `src/design-system/primitives/AuthoringWorkspace.tsx`.
- Files touched (regenerate): `src/routeTree.gen.ts` (via plugin, no manual edit).
- No new routes; no changes to `__root.tsx`, `router.tsx`, `App.tsx`, or the `/$` splat.
- Control-channel messages use a discriminated union `{type:"payload"|"opener-closing"|"detached-alive", …}` on the existing per-key channel; no new channel names, no schema surprises for the child.
- Coalesced `publishPreview` retains "first paint" behavior by flushing immediately on the first call after the channel is idle, then debouncing subsequent updates.
- `AuthoringWorkspace` state additions are local: `detachedWindow`, `isDetached`, `lastHeartbeatAt`. No global store, no context, no cross-cutting refactor.

## Out of scope

- Fixing the unrelated dev-server-wide 500 (only restart it enough to verify this feature).
- Migrating any legacy `<App/>` route into TanStack file-based routing.
- Applying the detach pattern to non-localization editors (call-site parity is a follow-up once this is proven).
