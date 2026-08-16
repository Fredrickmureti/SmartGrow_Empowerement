# Landed Cost — Phase C and Phase E closeout

## Phase B remainder — verified, no code change needed

- **Concurrent post / re-post.** `landed_cost_allocate_voucher`,
  `landed_cost_post_voucher`, `_landed_cost_post_apply`,
  `landed_cost_reverse_voucher`, `inventory_apply_cost_revaluation` and
  `inventory_reverse_cost_revaluation` all take `FOR UPDATE` on the rows they
  mutate, and posting is idempotent by `(source_type, source_id)` through
  `post_journal_entry_atomic`. Confirmed from the live function definitions.
- **Cross-warehouse reversal.** `inventory_reverse_cost_revaluation` iterates
  `inventory_cost_revaluations` **per cost layer**, and a layer belongs to one
  warehouse, so the unwind is warehouse-correct by construction — it does not
  need a `warehouse_id` of its own. Apply and reverse both attribute the ledger
  by product (not by warehouse), so the two directions are symmetric and
  clearing always washes to zero. Per-warehouse GL segmentation is a
  chart-of-accounts concern, not a landed-cost one, and is out of scope here.

## Phase C — the parallel verification path is retired

`landed_cost_selftest` and `landed_cost_selftest_run` were dropped. They were a
second, non-canonical verification route that wrote AVCO, cost layers and stock
movements inside a rolled-back transaction, and had to be permanently exempted in
two single-writer registries (`inventory_valuation_writers`,
`stock_movement_writers`) — both exemption rows were deleted with them. Nothing
in the application referenced either function.

Everything they asserted is now covered by the `supabase/tests/landed_cost_*`
probe files, which read live data instead of minting privileged fixtures.

Post-change: `check_valuation_writer_coverage()` returns 0 issues and
`check_inventory_valuation_drift()` returns 0 rows.

## Phase E — the workbench stops keeping its own totals

The workspace summed its KPI cards and its lifecycle bucket counts in the browser
from a 500-row page of `landed_cost_vouchers`. That is a second landed-cost
total: past 500 vouchers every headline figure silently under-reported, and the
bucket chips disagreed with the database.

Added `landed_cost_workspace_summary(business_id)` — one set-based aggregate over
every voucher in the business, returning lifecycle counts plus unposted,
capitalised and expensed money. It is `STABLE` with **invoker rights** (no
`SECURITY DEFINER`), exactly like `landed_cost_clearing_exposure`, so RLS on
`landed_cost_vouchers` scopes it; `authenticated` and `service_role` may execute.

Frontend: `useLandedCostWorkspaceSummary` consumes it, `LandedCostListPage`
renders it, and the client-side `landedCostKpis` reducer was deleted rather than
left available. The cards now speak operator language — "Capturing charges",
"Awaiting posting", "Charge value not yet in the ledger", "Added to stock value"
— and show `—` rather than a fabricated zero while the aggregate is loading.

## Ratchets

- `supabase/tests/landed_cost_workspace_and_selftest_test.sql` — the self-test
  functions stay dropped and stay out of both writer registries; the summary
  exists once, is non-volatile, invoker-rights, read-only, unpaged and
  app-executable; every live voucher status maps to exactly one workspace bucket.
- `landed-cost.test.ts` gains a guard rejecting any client-side reduce over
  landed-cost money and any lifecycle count taken from a paged row set.

## Checks run

`npm run typecheck:landed-costs` clean; `landed-cost.test.ts` (8),
`landed-cost-currency.test.ts` (7) and
`stock-event-fabric-and-landed-cost.test.ts` (10) all pass; live aggregate
cross-checked against a hand-written equivalent query (1 voucher, reversed →
`closed: 1`, all money zero).

## Correction — Phase D is NOT blocked (verified 2026-08-16)

An earlier note in this file claimed weight / volume allocation was blocked
because the product model held no net weight or volume. **That was wrong.** It
read only the legacy POS columns on `products` (`tare_weight`, `weight_unit`,
`is_weighted`) and missed the canonical physical-attribute model. Verified
against the live database and the running code:

- `public.product_physical_attributes` holds `net_weight`, `tare_weight`,
  server-derived `gross_weight`, `volume`, `length`/`width`/`height`, each with
  its own UoM reference (`*_uom_id`, `dimension_uom_id`), keyed by
  `(product_id, packaging_id)` — so a base unit and every pack level can carry
  their own measurements. 4 RLS policies, grants present for
  `anon`/`authenticated`/`service_role`, and integrity is enforced by
  `trg_enforce_physical_attribute_integrity` (dimension validity, tenant match,
  packaging ownership, gross = net + tare).
- `resolve_product_measure(business, product, packaging, measure, target_uom)`
  normalises a measure to the business's reference unit for that dimension,
  falls back from a pack level to base × pack size, returns NULL when the fact
  is simply absent, and **fails closed** when no reference unit is configured
  rather than summing mixed units.
- `landed_cost_allocate_voucher` already allocates by both physical bases: it
  resolves mass and volume reference units, measures each receipt line at the
  packaging level it was actually received in (`gross_weight` preferred, falling
  back to `net_weight`), sums the basis across scope, and refuses with a
  per-product message only when a line in that specific voucher has no measure.
  `landed_cost_allocation_basis` exposes `value | quantity | weight | volume |
  manual` and the enum values are live.
- Capture exists in the UI: `ProductForm` renders a "Physical attributes"
  section (`ProductPhysicalAttributesEditor`) with Net weight, Packaging (tare)
  weight, Volume + unit, and Length/Width/Height for the base unit and each
  packaging level; `InventorySettings` can make physical attributes mandatory
  before receiving via `require_product_physical_attributes`.

So the refusal seen in testing is **data absence, not a modelling gap** —
`product_physical_attributes` currently has 0 rows in this database. Nothing to
build in the product domain and nothing to patch inside landed cost.

Only change made from this finding: the basis picker hints in
`LandedCostComponentTypesPage` said "Requires net weight on the product master",
which pointed operators at the wrong screen. They now name the product's
physical attributes and state that the measure is taken at the packaging level
received.

## Still open

- Nothing for Phase D. To exercise weight/volume end to end, capture physical
  attributes on the products in a receipt and allocate a component on that
  basis; the engine handles the rest.
- Authenticated end-to-end browser verification of the workspace is unavailable
  in this environment (external, unmanaged Supabase — the app redirects to
  sign-in and no session can be minted here).

