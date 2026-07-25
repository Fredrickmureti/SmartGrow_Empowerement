## Goal

`/hr/payroll/legal-orders` currently forces the whole page to scroll sideways on a 393px phone. Fix it so the page itself never scrolls horizontally — only wide data tables scroll, inside their own container.

## What's causing it (verified in code)

1. `src/pages/hr/payroll/LegalOrdersWorkspace.tsx` — the tab bar renders 8 items (`Tasks … Audit`) in a plain `flex gap-1` row with no wrapping and no overflow container. At ~393px this row is far wider than the viewport and drags the whole page with it. The header also uses a fixed `px-6` while the app shell already applies `px-4` padding.
2. Tab pages use fixed desktop padding `p-6` and KPI grids that stay `grid-cols-1` until `md:` — so cards are full-width-tall on mobile and the padding eats the narrow viewport.
3. Toolbar rows (`flex items-center justify-between` with title + buttons) don't wrap on narrow screens.
4. Tables themselves are fine (the shadcn `Table` primitive already wraps in `overflow-auto`), but they sit inside flex/grid parents without `min-w-0`, so the wrapper can't shrink and the overflow escapes to the page.

## Changes (presentation only — no data/logic changes)

### 1. Workspace shell — `LegalOrdersWorkspace.tsx`
- Header padding: `px-6 pt-6` → `px-4 sm:px-6 pt-4 sm:pt-6`.
- Title: `text-2xl` → `text-xl sm:text-2xl`; description gets `max-w-2xl`.
- Tab nav: wrap in a horizontally scrollable strip — `overflow-x-auto` + `whitespace-nowrap` + `flex-nowrap`, hidden scrollbar (`[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`), each `NavLink` gets `shrink-0`, icon gets `shrink-0`. So the tabs swipe sideways instead of the page.
- Root container gets `min-w-0 w-full` and the `<Outlet />` wrapper gets `min-w-0`.

### 2. Tasks tab — `LegalOrdersTasks.tsx`
- `p-6 space-y-6` → `p-4 sm:p-6 space-y-4 sm:space-y-6`.
- KPI grid: `grid-cols-1 md:grid-cols-4` → `grid-cols-2 md:grid-cols-4` (two compact KPIs per row on phones); KPI value `text-2xl` → `text-xl sm:text-2xl`, label wraps rather than overflows.
- `TaskCard` list rows: `flex items-center justify-between` → `flex flex-wrap items-start justify-between gap-2`, text block gets `min-w-0` + `break-words`, action button `shrink-0`.

### 3. The seven remaining tab pages
`Garnishments.tsx`, `LegalRecipients.tsx`, `LegalOrderPacks.tsx`, `LegalOrderRemittanceBatch.tsx`, `LegalOrderRemittanceBatches.tsx`, `LegalOrdersReports.tsx`, `LegalOrdersAudit.tsx` — apply the same consistent mobile pass:
- `p-6` → `p-4 sm:p-6`.
- KPI/summary grids: `grid-cols-1 md:grid-cols-N` → `grid-cols-2 md:grid-cols-N` (keep `grid-cols-1 sm:grid-cols-2` where the cell content is long text).
- Header/toolbar rows: add `flex-wrap gap-2` and let filter `Select`/`Input` controls go `w-full sm:w-auto`.
- Every `Card` that hosts a `Table`: ensure the card content has `min-w-0` / `p-0 sm:p-6`-style handling so the table's own `overflow-auto` is what scrolls, not the page. Wide tables keep all columns and scroll horizontally inside the card (no column hiding, no row-to-card restyle) — accountants need the full row.
- `LegalOrdersAudit.tsx` detail `<pre>` blocks already have `overflow-x-auto`; add `break-all` on long ids/JSON values.

### 4. Verification
- Playwright at 393×852: navigate each of the 8 tabs and assert `document.documentElement.scrollWidth <= clientWidth` (no page-level horizontal scroll), and capture a screenshot per tab.
- Run the existing legal-orders architecture tests (`legal-orders-phase4-workspace`, `phase6-packs`, `phase8-audit`) plus the typecheck.

## Out of scope
No changes to hooks, queries, RPCs, permissions, or any business logic. Purely Tailwind class / layout markup edits in the eight page files.
