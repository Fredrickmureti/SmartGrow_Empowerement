# Inventory / Stock Reporting Wave — authoritative status

**Currently active phase:** Phase 5 — Stock Aging on cost layers (not started).
**Last completed:** Phase 4 — Stock Ledger page (implemented and verified).

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

## Pending

**Phase 5 (NEXT) — Stock Aging.** `src/pages/reports/StockAgingReport.tsx`
currently ages the product, not the cost layer. Add a
`report_inventory_aging_as_of(p_org, p_business, p_as_of, p_branch,
p_warehouse, p_product, p_category, p_limit, p_offset)` RPC that buckets each
remaining cost layer by `received_at` age (0–30 / 31–60 / 61–90 / 90+),
returning qty and value per bucket plus `total_rows`; mirror the Phase 1
security shape (SECURITY DEFINER, pinned `search_path`,
`_assert_inventory_report_access`, no `anon` grant). Add an `inventory_aging`
key to `columnSpecs.ts` and a builder branch in `inventoryData.ts`, then
rebuild the page on the same hook/engine pattern as Phases 3–4 and register it.
Aging totals must tie to Inventory Valuation total value at the same date.

**Phase 6 — Integrity + Inventory⇄GL reconciliation** onto the unified engine
with a single reconciliation RPC signature.

**Phase 7 — Lot/serial traceability report.**

## Instructions for the next agent

1. **Verify Phases 3–4 before writing anything new.** Read
   `src/hooks/inventory/useInventoryReportRpcs.ts`,
   `src/pages/reports/InventoryValuationReport.tsx` and
   `src/pages/reports/StockLedgerReport.tsx`. Confirm: no client-side value
   derivation, paging honours `total_rows`, exports are server-built
   (`reportType` + org + period, empty `rows`/`columns`), both pages are in
   `REPORT_REGISTRY`, routed, and reachable from the Inventory sidebar.
2. **Confirm the numbers tie.** In the SQL editor, run
   `supabase/tests/inventory_reporting_ratchet_test.sql` and check the tie-out
   notice (ledger closing qty == valuation qty on hand). Investigate any
   TIE-OUT warning before adding a new report.
3. **Then resume at Phase 5** exactly as specified above. Do not start Phase 6
   or 7, and do not detour into the unrelated pre-existing test failures listed
   above.
4. **Update this file** as each phase closes: what is verified, what is
   pending, active phase, next phase.
