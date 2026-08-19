# Inventory / Stock Reporting Wave — status and remaining phases

## Done

**Phase 1 — RPC foundation + security (COMPLETE).**
`report_stock_ledger` and `report_inventory_valuation_as_of` exist, are
SECURITY DEFINER with a pinned `search_path`, and assert business/branch access
via `_assert_inventory_report_access`. Phase 1b closed the two open defects:
`EXECUTE` revoked from `anon`/`PUBLIC` on all inventory reporting and
diagnostic RPCs (granted to `authenticated` + `service_role` only), and the
duplicate 3-argument `reconcile_inventory_subledger_to_gl` overload dropped so
the app's RPC call is no longer ambiguous.

**Phase 2 — server report builder (COMPLETE).**
`_shared/reports/inventoryData.ts` builds both reports from the same RPCs, and
`columnSpecs.ts` carries the `stock_ledger` and `inventory_valuation` keys, so
exports and the scheduler resolve columns from the registry.

**Phase 3 — Inventory Valuation page (COMPLETE).**
`src/pages/reports/InventoryValuationReport.tsx` no longer computes
`live on-hand × current AVCO`. It reads `report_inventory_valuation_as_of`
through the new `useInventoryValuationAsOf` hook
(`src/hooks/inventory/useInventoryReportRpcs.ts`, explicit paging on
`total_rows`), renders through `ReportSurface`/`ReportTable`, and exports
server-built with `reportType: "inventory_valuation"` so screen and PDF are the
same dataset. Registered in `REPORT_REGISTRY` as `inventory-valuation` at
`/inventory-app/reports/valuation`.

## Remaining

**Phase 4 — Stock Ledger page.** New page on `report_stock_ledger`
(opening → in/out → closing per product/warehouse) using `useStockLedger`,
registered with `reportType: "stock_ledger"`.

**Phase 5 — Stock Aging.** Age each cost layer, not the product; drop the
client-side approximation.

**Phase 6 — Integrity + Inventory⇄GL reconciliation** onto the unified engine
(single reconciliation RPC signature).

**Phase 7 — Lot/serial traceability report.**

## Verification notes

- `tsgo --noEmit` on `tsconfig.app.json`: clean.
- Report architecture guards (routing parity, nav-registry, registry key
  coverage, single engine, data-source contract): 55 tests pass.
- `supabase/tests/inventory_reporting_ratchet_test.sql` needs a psql session;
  this environment has no `PGHOST`, so it must be run from the SQL editor.
