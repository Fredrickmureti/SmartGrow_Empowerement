# Fix: App rail is icons-only and cannot expand

## Verdict

Confirmed. There are two side navigation panels:

1. **`AppRail`** (`src/components/layout/shell/AppRail.tsx`) — the outer 56px rail listing installed apps. Hard-coded to `w-14`, icons only, discovery relies entirely on hover tooltips. No expand affordance.
2. **`WorkspaceSidebar`** (`src/components/layout/shell/WorkspaceSidebar.tsx`) — the inner per-app submodule panel. Already has a collapse toggle with `w-14` ↔ `w-60`, state persisted in `localStorage` under `lov:workspace-sidebar:collapsed`.

Both are rendered side-by-side in `PlatformShell` (lines 150–151). The asymmetry is real: submodules expand, apps don't.

## What to change

Bring the AppRail to feature-parity with WorkspaceSidebar's collapse pattern, keeping it visually the outer rail (a bit narrower than the submodule panel when expanded so the hierarchy still reads correctly).

### AppRail changes

- Add `collapsed` state, persisted in `localStorage` under `lov:app-rail:collapsed`. Default: collapsed (preserves current density).
- Widths: `w-14` when collapsed (unchanged), `w-52` when expanded (narrower than the 60-unit submodule panel).
- When expanded:
  - Show app name to the right of each icon (`truncate`, brand-color accent bar unchanged).
  - Show "Home" and "All apps" labels next to their icons.
  - Drop the tooltip (label is now visible) — keep tooltips only in collapsed mode.
- Add a bottom toggle button (chevron-left / chevron-right), mirroring `WorkspaceSidebar`'s toggle position and styling for consistency.
- Keep the accent bar, active state, sort order, and platform-app filter untouched.
- Keep the outer `<aside>` sticky/full-height as today.

### No other files change

`PlatformShell` composes the two side-by-side already; both being flex children of the same row means the layout absorbs the extra width automatically. The main content area uses `flex-1` and doesn't need adjustment.

## Out of scope

- No changes to WorkspaceSidebar behavior, storage key, or defaults.
- No change to mobile behavior (rail remains `hidden md:flex`).
- No redesign of tooltips, colors, or icon sizes.
- No routing changes.

## Technical details

- File touched: `src/components/layout/shell/AppRail.tsx` only.
- New imports: `useState`, `useEffect`, `ChevronLeft`, `ChevronRight` from lucide-react.
- `TooltipProvider` stays; tooltips render conditionally based on `collapsed`.
- SSR-safe localStorage read (guard with `typeof window !== "undefined"`), matching the pattern already used in `WorkspaceSidebar`.
