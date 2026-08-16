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

## Still open

- **Phase D — weight / volume allocation bases.** Correctly still refused by
  `landed_cost_allocate_voucher`: the product master carries `tare_weight`,
  `weight_unit` and `is_weighted` but no net weight and no volume. This is a
  product-domain change (net weight and volume with UoM, normalised through the
  canonical UoM engine), not something to patch inside landed cost.
- Authenticated end-to-end browser verification of the workspace is unavailable
  in this environment (external, unmanaged Supabase — the app redirects to
  sign-in and no session can be minted here).
