## Business event

The Product Detail sheet is a **peek** — the operator's business event is "I need context about this product to decide the next action (replenish, adjust, transfer, edit price)." Peeks must open instantly with a cheap headline and defer heavy analytics. Judged against that yardstick, three separate problems are stacked in the current implementation, only one of which the user surfaced.

## What I found

### 1. Mobile paint glitches ("CD-ROM lines") — root cause is a real DOM bug, not styling

Console proves it (already in this session's logs):

```
Warning: validateDOMNesting(...): <div> cannot appear as a descendant of <p>.
  at Badge → at p (SheetDescription) → at SheetHeader → at ProductDetailPanel
```

`ProductDetailPanel.tsx` (L177–193) renders 3–8 `<Badge>` (a `<div>`) inside `<SheetDescription>` (a `<p>`). Browsers auto-close the `<p>` at the first block child, so React's virtual tree and the browser's real tree diverge. Every re-render (loading→loaded, data updates, tab switches, resize) triggers hydration/reconciliation against the wrong parent — on mobile Safari/Chromium this produces exactly the horizontal-tear/scanline artifact the user described, because the browser is re-painting an element whose parent it silently reparented.

This is a functional HTML validity bug, not a design choice. Fixing it removes the glitch on every mobile device, not just this one.

### 2. Perceived 4-second load — the data hook is sequential, not composed

`useProductDetailData` (`src/hooks/inventory/useProductDetailData.ts`) runs **nine Supabase round-trips serially** inside one `queryFn`: product → warehouse_stock → lots → packaging → identifiers → reorder rules → recent movements → open POs → 28-day velocity. Each `await` blocks the next. On a 150 ms RTT that is 1.3 s minimum before any tab can render; on flaky mobile it becomes 3–5 s — matching the reported delay.

Only three of these queries feed the header + intelligence strip that shows first (product, warehouse_stock, packaging). The other six feed tabs the user hasn't clicked yet.

### 3. Design-system drift — the peek does NOT use the shared primitive

The inventory audit doc (`docs/design-system/audit/inventory.md`) claims the Product peek is "Done" on `PeekScaffold`. It is not — `ProductDetailPanel` uses the raw `<Sheet>` from `components/ui/sheet` directly. Compare to how it *should* look: `AdjustmentPeekSheet`, `AssetPeekSheet`, `JournalEntryPeekSheet`, `SalesPeekScaffold` all compose the design-system primitive. The Product peek is the last inventory record surface still living outside the system, which is why its header/footer contract, sizing, and mobile behavior all differ from every other peek in the ERP.

### Bonus finding surfaced by the same investigation

Fixed and Adjustment peeks pass their badge cluster through `PeekScaffold`'s dedicated `badges` slot (rendered outside the `<p>`), so they don't have the DOM-nesting bug. Every peek that hand-rolls a `<Sheet>` is a candidate for the same class of issue. The correct fix is not "wrap badges in a span" — it is to stop hand-rolling the sheet.

## Plan (three layers, one PR)

### Layer A — visual/functional fix (removes the mobile glitch)

Migrate `ProductDetailPanel` from raw `<Sheet>` to `PeekScaffold` (same primitive already used by Adjustment / Asset / Journal Entry / Sales peeks):

- Move title, SKU, and type into `PeekScaffold`'s `title` / `subtitle` slots (plain text — no block children).
- Move all badges (Inactive, Out of stock, Low stock, Negative, Lot-tracked, Expiry, Multi-UoM) into the scaffold's `badges` slot, which renders them in a sibling `<div>`, not inside the description `<p>`.
- Move Edit / Delete into `headerActions`; keep the deep-link action row (Adjust, Transfer, Replenish, Forecast, Movements) in the body as a `FooterActionBar` at `anchor="sheet"` so it sticks on mobile instead of scrolling away.
- Delete the outer `overflow-y-auto` — the scaffold owns the scroll container, so nested scrollers (a documented source of iOS paint tearing) disappear.

### Layer B — performance fix (kills the 4-second perceived load)

Rework `useProductDetailData` from serial to a two-phase composed fetch:

- **Phase 1 — critical path, `Promise.all`**: product + warehouse_stock + packaging. This is everything the header, badges, and intelligence strip need. Target ≤300 ms on a warm cache, ≤1 s cold.
- **Phase 2 — deferred, `Promise.all`**: identifiers, reorder rules, lots, recent movements, open POs, velocity. Fired via a second `useQuery` keyed the same way, `enabled` only after phase 1 resolves, with `placeholderData` so tabs render with skeletons instead of blocking the peek open.
- Keep the existing 30 s `staleTime` and cache key shape so nothing downstream (invalidations, subscribers) breaks.

Expected result: sheet paints headline + tiles in one frame; tabs light up as their slice arrives.

### Layer C — consistency + regression guard

- Update `docs/design-system/audit/inventory.md` to describe the peek as actually shipped on `PeekScaffold` (the row currently misrepresents reality).
- Extend `src/test/architecture/inventory-record-dialog-ban.test.ts` to also fail if any file under `src/components/products/**` imports `Sheet` from `@/components/ui/sheet` — that closes the door on future drift.
- Grep the other inventory peeks for the same `<Badge>`-inside-`<SheetDescription>` pattern; if any exist, fix them in the same pass so we don't ship a partial cure.

## Explicitly NOT in this PR

- No changes to the tab bodies (`OverviewTab`, `StockTab`, `MovementsTab`, etc.) — they already consume `data` slices and continue to work with the two-phase hook.
- No schema/RPC changes. If phase 2 is still slow after parallelization, the next step is a `get_product_detail_bundle(product_id, branch_id)` Postgres function returning one JSON payload — but that's a separate migration and should be validated with real timings first.
- No visual redesign of tab content — the request was UX quality, not a re-layout.

## Files touched

- `src/components/products/detail/ProductDetailPanel.tsx` — rewrite on `PeekScaffold`
- `src/hooks/inventory/useProductDetailData.ts` — split into critical + deferred queries
- `src/test/architecture/inventory-record-dialog-ban.test.ts` — extend guard
- `docs/design-system/audit/inventory.md` — correct the audit row

Ready to build on approval.