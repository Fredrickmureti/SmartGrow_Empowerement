# Inventory / Stock Reporting Wave — authoritative status

**Currently active phase:** Phase 6 — Integrity + Inventory⇄GL reconciliation
(not started).
**Last completed:** Phase 5 — Stock Aging on cost layers (implemented and
verified).

## Completed and verified

**Phase 1 — RPC foundation + security (DONE).**
`report_stock_ledger` and `report_inventory_valuation_as_of` are SECURITY
DEFINER with a pinned `search_path` and assert business/branch access through
`_assert_inventory_report_access`. Phase 1b closed the two open defects:
`EXECUTE` revoked from `anon`/`PUBLIC` on every inventory reporting and
diagnostic RPC (granted to `authenticated` + `service_role` only), and the
duplicate 3-argument `reconcile_inventory_subledger_to_gl` overload dropped so
the app's RPC call is no longer ambiguous.
Verified by: grant query against `pg_proc` + `has_function_privilege`.

**Phase 2 — server report builder (DONE).**
`supabase/functions/_shared/reports/inventoryData.ts` builds both reports from
the same RPCs; `columnSpecs.ts` carries the `stock_ledger` and
`inventory_valuation` keys, so exports and the scheduler resolve canonical
columns from the registry.

**Phase 3 — Inventory Valuation page (DONE).**
`src/pages/reports/InventoryValuationReport.tsx` no longer computes
`live on-hand × current AVCO`. It reads `report_inventory_valuation_as_of` via
`useInventoryValuationAsOf` (`src/hooks/inventory/useInventoryReportRpcs.ts`,
explicit paging on `total_rows`, 5k page size), renders through
`ReportSurface`/`ReportTable`, and exports server-built with
`reportType: "inventory_valuation"`. Registered as `inventory-valuation` at
`/inventory-app/reports/valuation`.

**Phase 4 — Stock Ledger page (DONE).**
New `src/pages/reports/StockLedgerReport.tsx`: opening → in → out → closing per
product/warehouse from `report_stock_ledger` via `useStockLedger`, period +
branch-scope filters, grand-total row, server-built export with
`reportType: "stock_ledger"` (full dataset, canonical columns). Wired end to
end: route `reports/ledger` in `src/apps/inventory/routes.tsx`, sidebar entry
in `src/apps/inventory/nav.ts`, registry entry `stock-ledger` at
`/inventory-app/reports/ledger`.
Both pages now type their export as `ServerBuildConfig` (no casts).

### Verification evidence for Phases 3–4
- `tsgo --noEmit -p tsconfig.app.json`: clean.
- Report architecture guards pass: routing parity, nav-registry, registry key
  coverage, single engine, data-source contract (74 assertions).
- Known unrelated pre-existing failures (NOT caused by this wave, do not chase
  them here): `financial-reports-scope-labeling` (Partner Ledger, Audit Trail,
  Budget vs Actual branch scoping) and `wms-rpc-grants`.
- `supabase/tests/inventory_reporting_ratchet_test.sql` still needs a psql
  session; this sandbox has no `PGHOST`, so run it from the SQL editor.

**Phase 5 — Stock Aging page (DONE).**
New RPC `public.report_inventory_aging_as_of(p_org, p_business, p_as_of,
p_branch, p_warehouse, p_product, p_category, p_limit, p_offset)`: ages each
*remaining cost layer* by its own `received_at` at the as-of date into
0–30 / 31–60 / 61–90 / 90+ buckets, returning qty + value per bucket,
`qty_on_hand`, `total_value`, `oldest_receipt_at`, `layer_count` and
`total_rows`. Same security shape as Phase 1 (SECURITY DEFINER, pinned
`search_path`, `_assert_org_member` + `_assert_inventory_report_access`,
`can_access_branch` row guard, EXECUTE revoked from PUBLIC/anon, granted to
`authenticated` + `service_role` only — verified via `has_function_privilege`).
Server side: `inventory_aging` key in `columnSpecs.ts`, builder branch in
`_shared/reports/inventoryData.ts`, dispatch added in
`render-report/index.ts`. Client side:
`src/pages/reports/StockAgingReport.tsx` fully rebuilt on
`useInventoryAgingAsOf` (`useInventoryReportRpcs.ts`, paged on `total_rows`) —
no more "age the product by its last inbound movement × current cost price".
Registered as `stock-aging` at `/inventory-app/reports/aging` (route and
sidebar entry already existed); server-built export with
`reportType: "inventory_aging"`.
Because the aging buckets are exhaustive and disjoint over the SAME
`qty_as_of × unit_cost` layer arithmetic the valuation RPC uses, bucket values
sum to `total_value`, which ties to Inventory Valuation at the same date.

### Verification evidence for Phase 5
- `tsgo --noEmit -p tsconfig.app.json`: clean.
- Guards pass: routing parity, nav-registry, registry key coverage, single
  engine, data-source contract, filter-provider wrap, layout coverage,
  aging-single-source, module-report-screens (120 tests).
- Grant state confirmed: anon `false`, authenticated `true`, service_role
  `true`, `prosecdef = true`, `search_path = public`.
- Still outstanding (environmental, not a defect):
  `supabase/tests/inventory_reporting_ratchet_test.sql` needs a psql session;
  this sandbox has no `PGHOST`, and `read_query` cannot execute the reporting
  RPCs (EXECUTE is intentionally restricted to authenticated/service_role), so
  run the tie-out from the SQL editor as a signed-in user.

## Pending

**Phase 6 — Integrity + Inventory⇄GL reconciliation** onto the unified engine
with a single reconciliation RPC signature.

**Phase 7 — Lot/serial traceability report.**

## Instructions for the next agent

1. **Verify Phases 3–5 before writing anything new.** Read
   `src/hooks/inventory/useInventoryReportRpcs.ts`,
   `src/pages/reports/InventoryValuationReport.tsx`,
   `src/pages/reports/StockLedgerReport.tsx` and
   `src/pages/reports/StockAgingReport.tsx`. Confirm: no client-side value
   derivation (no `qty × cost_price`, no `warehouse_stock`/`products.
   stock_quantity` reads), paging honours `total_rows`, exports are
   server-built (`reportType` + org + period, empty `rows`/`columns`), all
   three pages are in `REPORT_REGISTRY`, routed, and reachable from the
   Inventory sidebar. Confirm the aging RPC is still anon-denied.
2. **Confirm the numbers tie.** In the SQL editor, signed in as a real user,
   run `supabase/tests/inventory_reporting_ratchet_test.sql` and additionally
   check that, for the same business and date,
   `sum(total_value)` from `report_inventory_aging_as_of` equals
   `sum(total_value)` from `report_inventory_valuation_as_of`, and that the
   four aging buckets sum to that same total. Extend the ratchet test with
   this aging assertion. Investigate any TIE-OUT warning before continuing.
3. **Then resume at Phase 6** exactly as specified below. Do not start Phase 7,
   and do not detour into the unrelated pre-existing test failures listed
   above.
4. **Update this file** as each phase closes: what is verified, what is
   pending, active phase, next phase.
