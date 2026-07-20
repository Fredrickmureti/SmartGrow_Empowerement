## Problem

`/settings/scanner` renders a `container mx-auto max-w-3xl` wrapper *inside* `PlatformShell`, which already caps content at `max-w-6xl`. The `max-w-3xl` (~768px) forces the content into a narrow column and creates the "huge left/right margin, content squeezed to center" effect the user sees.

The four Hardware pages have parallel issues at various breakpoints:

- `HardwareDevices` — sits fine inside the shell on desktop, but the "Assignments" table and header/action row can overflow on small screens (no horizontal scroll wrapper, buttons wrap awkwardly).
- `DeviceWizard` — adds its own `container mx-auto max-w-5xl`, further narrowing content and duplicating shell padding.
- `HardwareDiagnostics` — table has `overflow-x-auto` already, but the header row (title + action buttons) doesn't wrap gracefully on mobile.
- `HardwareTopology` — uses raw inline `style={{ padding: 24 }}`, a hard-coded `fontSize: 18`, and a 7-column table with no horizontal scroll wrapper; the layout breaks on tablet/mobile and doesn't inherit shell padding tokens.

## Changes (frontend/presentation only)

1. **`src/pages/settings/ScannerSettings.tsx`**
   - Replace the outer `container mx-auto py-8 space-y-6 max-w-3xl` with a full-width stack (`space-y-6 py-2`) so the page fills the shell's content region and inherits its responsive padding (`px-4 sm:px-6 lg:px-8`).
   - Leave the internal Cards and RadioGroups untouched — they already stretch to their parent.

2. **`src/apps/platform/hardware/DeviceWizard.tsx`**
   - Drop the `container mx-auto max-w-5xl p-4 sm:p-6` wrapper down to `space-y-6` (shell handles padding + width).

3. **`src/apps/platform/hardware/HardwareDevices.tsx`**
   - Keep the outer `space-y-6 p-4 md:p-6` but ensure the header row uses the `grid-cols-[minmax(0,1fr)_auto] sm:flex` pattern from the responsive-layout skill so title + action buttons don't clip on mobile.
   - Wrap the Assignments `<Table>` in an `overflow-x-auto` container so it scrolls horizontally on small screens instead of overflowing the viewport.

4. **`src/apps/platform/hardware/HardwareDiagnostics.tsx`**
   - Convert the top header (`flex items-start justify-between`) to the same grid→flex responsive pattern so title and action buttons stack cleanly on mobile.

5. **`src/apps/platform/hardware/HardwareTopology.tsx`**
   - Remove all inline `style={{...}}` blocks and rewrite with Tailwind tokens (`space-y-8 p-4 md:p-6`, `text-lg font-semibold`, `text-sm text-muted-foreground`, semantic border/`muted-foreground` colors instead of `#666`/`#ddd`/`#0a7`/`#a30`).
   - Wrap each business's `<table>` in `overflow-x-auto` so it scrolls on mobile.
   - Use `text-success` / `text-destructive` tokens for the online/offline status text.

No changes to data hooks, business logic, routing, or the `PlatformShell` itself.

## Verification

- Reload `/settings/scanner` at 1338px width — content should span the shell content region, no giant side margins.
- Resize each of the four hardware pages down to ~375px — headers wrap without clipping, tables scroll horizontally, no horizontal page scroll.
