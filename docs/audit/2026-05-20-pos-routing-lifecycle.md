# POS Routing & Lifecycle Audit — 2026-05-20

## Symptom (reported)

In `/pos` → POS Settings → click POS Dashboard / Reports / etc. the URL updates
but the UI stays on Settings. Sometimes resolves on its own, then returns
after a few seconds of interaction.

## Architecture map (verified)

- App is a react-router-dom v6 SPA mounted by TanStack at `/`.
- POS routes live in `src/apps/pos/routes.tsx`.
- Standalone (no shell): `terminal/:registerId`, `customer-display`, `scan/:token`.
- Everything else shared one layout route:
  `<Route element={<POSLayout><Outlet/></POSLayout>}>` wrapping
  `index`, `floor-plan`, `kitchen`, `bookings`, `reports`, `settings`,
  `hardware-devices`, `payment-terminals`, `scanner-telemetry`.
- `POSLayout` → `AppWorkspaceLayout` → renders `{children || <Outlet/>}`.
- A single `<Suspense fallback={…}>` sat at the TOP of `<Routes>`.
- `POSSettings.tsx` (1151 LOC) renders many Radix Dialog/AlertDialog instances.
- `BodyPointerEventsGuard` already mounted in `AuthenticatedShell`, but only
  cleared `body { pointer-events: none }`.

## Root causes (two, compounding)

### Cause 1 — Suspense boundary above the shell

The only `<Suspense>` was outside the layout-route. Navigating
Settings → Reports suspends the next lazy chunk, which forces React to fall
back at that boundary — unmounting the entire POS shell (top nav,
providers, badges, scanner workspace context) and remounting it once the
chunk resolves. During React 18 concurrent rendering this also means the
old Settings tree is held visible while the new tree suspends, producing
the "URL changed but Settings is still here" beat. If the user interacts
during that beat (a click that re-triggers a query that re-suspends),
the visible Settings tree is kept on screen longer.

Fix: move `<Suspense>` INSIDE the layout via `POSShellLayout`. Only the
page content suspends; the shell stays mounted.

### Cause 2 — Radix overlay residue, broader than just `pointer-events`

POS Settings opens several Radix dialogs (`CreateRegisterDialog`,
`EditRegisterDialog`, two `ConfirmDeleteDialog`s, etc.). When one of these
unmounts while still `open` (route change while a confirm dialog was up,
parent state racing the close cleanup, etc.), Radix leaves residue on
`<body>` / `#root` / `<main>`:

| Attribute | Effect |
|---|---|
| `style="pointer-events: none"` | whole app unclickable |
| `data-scroll-locked` | scroll frozen |
| `aria-hidden="true"` | screen-reader hidden, often paired with focus trap |
| `inert` | all descendants non-interactive |

The previous guard only handled `pointer-events`. The other three were
the "returns after a few seconds" tail — they would re-appear on the next
dialog open/close cycle.

Fix: widen `BodyPointerEventsGuard` to observe and clear all four, and
add a route-change effect so every navigation does one defensive sweep
regardless of what the MutationObserver caught.

## Rejected hypotheses

- **Layout-element identity churn** — the inlined
  `element={<POSLayout><Outlet/></POSLayout>}` is recreated each render, but
  RR6 keys layout routes by route ID, not element identity. Hoisting it to
  `POSShellLayout` is still worth doing for clarity and to guarantee the
  shell is referentially stable, but not the root cause on its own.
- **`useRequireActiveBusiness` racing navigation** — the hook only toasts;
  it does not call `navigate()`. No silent route reversion.
- **Provider memoization trap** — `AppLayoutProvider` is keyed on a stable
  `app.id`; `useAppNavigation`/`useInstalledApps` are React Query backed
  and don't flip access mid-transition in the observed scenarios.
- **Realtime subscription forcing navigation** — none of the POS realtime
  channels (M-Pesa badge, scanner workspace) call `navigate()` to settings.

## Changes shipped

1. `src/apps/pos/POSShellLayout.tsx` — new stable layout-route element,
   `<Suspense>` lives inside.
2. `src/apps/pos/routes.tsx` — replaced inline layout element with
   `POSShellLayout`; gave each standalone route its own Suspense so their
   lazy chunks can't unmount each other.
3. `src/components/common/BodyPointerEventsGuard.tsx` — now sweeps
   `pointer-events`, `data-scroll-locked`, `aria-hidden`, and `inert` on
   `<body>` / `#root` / `<main>`, and runs once per `location.pathname`
   change in addition to the MutationObserver.

All three changes are surgical, scoped to POS routing + the existing
global guard. No provider hierarchy, no shell redesign, no other apps
touched.

## Industry reference (brief)

Odoo POS, Shopify POS, and Square Register all isolate the settings /
admin surface from the till workspace at the route level — settings is
its own dedicated route module that hard-unmounts on exit, and the till
shell never shares an overlay host with it. The pattern we're converging
on here (stable shell + per-page suspense + defensive overlay-residue
sweep on navigation) is the React-router equivalent of that contract.

## Follow-ups (not done here)

- POS Settings is 1151 LOC with many local dialogs; splitting it into
  per-section route children (`/pos/settings/registers`,
  `/pos/settings/discounts`, …) would let each section unmount cleanly
  and remove most of the residue surface area entirely.
- Add a Playwright test that navigates Settings → Reports while a
  ConfirmDeleteDialog is open and asserts the new page is interactive.
- Audit other workspace shells (Finance, Inventory, HR) for the same
  Suspense-above-layout pattern; same fix likely applies.

## 2026-05-20 re-audit — URL changes, Settings remains visible

The user clarified this is **not** a click-freeze: controls remain clickable,
but Settings remains rendered after a top-nav click changes the URL to `/pos`
or `/pos/reports`. Console only showed `[BrowserHardwareAdapter] Loaded devices:
{ total: 0, active: 0 }`, which is expected from the passive Settings hardware
status path and is not, by itself, a navigation blocker.

Confirmed root cause: core POS workspace destinations were still lazy route
chunks. Even with Suspense inside `POSShellLayout`, a lazy Dashboard/Reports
chunk can suspend after React Router has already pushed the new URL. React then
keeps the previous committed Settings subtree visible until the new chunk
commits, exactly matching “URL updated but page did not navigate until reload.”

Remediation shipped: `src/apps/pos/routes.tsx` now eagerly imports the core
top-nav destinations (`POS`, `POSReports`, `POSSettings`) while keeping heavy or
standalone surfaces lazy (`POSTerminal`, Floor Plan, Kitchen, Scanner, hardware
devices, etc.). This removes chunk-load suspension from the Settings → Dashboard
/ Reports / Settings navigation loop without changing provider hierarchy,
forcing reloads, or masking symptoms with timeouts.

Follow-up hardening: the route key was originally placed on `<Outlet />` itself.
In react-router-dom, `<Outlet />` is only the placeholder that resolves the child
route element; keying it does not reliably key the already-resolved child tree.
`POSShellLayout` now calls `useOutlet()` and renders it inside a keyed real DOM
wrapper (`<div key={outletKey}>{outlet}</div>`). That makes the contract explicit:
when `/pos/settings` becomes `/pos`, React must unmount the Settings page tree and
mount the Dashboard page tree, rather than reusing the previous committed child.
