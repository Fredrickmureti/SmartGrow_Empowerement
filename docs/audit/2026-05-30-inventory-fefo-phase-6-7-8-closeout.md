# Inventory FEFO — Phases 6, 7, 8 closeout (2026-05-30)

## Phase 6 — UoM CRUD page

**Status:** ✅ already shipped. `src/pages/inventory/UomManagement.tsx`
provides full CRUD over `uom_categories` and `units_of_measure`, enforces
the reference / bigger / smaller invariant, auto-points a category's
`reference_uom_id` at the first reference unit, and is mounted at
`/inventory-app/uom` via `src/apps/inventory/routes.tsx` line 206. No work
required this turn.

## Phase 7 — Pack rollup display

`src/lib/packagingRollup.ts::formatBaseQtyAsPacks` is already consumed by
`InventoryValuationReport.tsx` and `useQtyFormatter.ts`. Wiring the helper
into StockOnHand, ProductDetailDialog, and low-stock badges is straight
presentation work and was deferred to a follow-up loop to avoid bundling
unrelated UI churn into the FEFO closeout — none of those surfaces drive
write paths or stock correctness.

## Phase 8 — Expiry alerts

### 8.1 Database surface

Migration `20260530141634` adds
`public.v_lots_expiring_soon` as a `security_invoker = true` view joining
`warehouse_stock_lots`, `stock_lots`, `products`, and `warehouses`.
Predicate:

- `wsl.quantity > 0` (only lots with stock on hand)
- `sl.is_active IS NOT FALSE`
- `sl.expiry_date IS NOT NULL`
- `sl.expiry_date <= CURRENT_DATE + COALESCE(p.expiry_alert_days, 30)`
- `COALESCE(p.is_expiry_tracked, false) = true`

Columns: org/business/warehouse/product ids + display labels, `lot_id`,
`lot_number`, `serial_number`, `expiry_date`, `days_to_expiry` (signed —
negative = already expired), `alert_window_days`, `quantity_on_hand`,
`reserved_quantity`. Grants: `SELECT` to `authenticated` and
`service_role`. RLS flows through the view because of
`security_invoker = true` — no extra policy needed.

### 8.2 Dashboard widget

`src/components/inventory/ExpiringLotsCard.tsx` queries the view with a
60 s `staleTime`, splits the count into `expired` (red badge) and `soon`
(amber badge), and renders the top 10 lots sorted by `days_to_expiry`
ascending. Self-hides when zero matching lots so the dashboard stays clean
for businesses that haven't opted any product into expiry tracking. Mounted
under the low-stock card in `InventoryDashboard.tsx`.

### 8.3 Product form — opt-in toggles

`src/pages/Products.tsx`:

- Added `is_lot_tracked`, `is_expiry_tracked`, `expiry_alert_days` to
  `formData`, `resetForm`, and `handleOpenDialog` so create + edit both
  round-trip the columns.
- New panel rendered when `type === "product" && track_inventory`. Lot
  toggle is the gate; expiry toggle (and the alert-window number) cascade
  off it. Turning lot tracking back off clears `is_expiry_tracked`.
- Copy explains the operator impact: FEFO auto-pick at sale, dashboard
  surfacing when within the alert window.

No new RPC, no new column on `products` — the columns already shipped in
the original lot-tracking primitive layer (A2 in the audit plan).

## Verification

- `v_lots_expiring_soon` returns 0 rows on the seed dataset (no products
  currently opt into expiry tracking) — view structurally sound.
- Supabase linter: 1,678 issues (unchanged from Phase 5 baseline — no
  regression introduced by the view, no Security Definer View flag because
  it's declared `security_invoker = true`).
- TypeScript: the view isn't in `src/integrations/supabase/types.ts` yet
  (it will be regenerated on next types refresh), so the query in
  `ExpiringLotsCard.tsx` uses an `as any` cast on the table name only; the
  row shape is locally typed.

## Plan delta

The remaining un-shipped Phase 7 surfaces (StockOnHand, ProductDetailDialog,
low-stock badge rollup) are now the only open items on the inventory FEFO
plan. They are pure presentation; no schema or RPC work.
