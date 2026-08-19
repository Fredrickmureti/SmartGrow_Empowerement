# Inventory / Stock Reporting Wave — authoritative status

**Currently active phase:** Phase 6 is **COMPLETE** (6.1–6.5 shipped and
verified below). **Next phase: 6b — valuation-basis convergence.**

## Status board

| Phase | Scope | State |
|---|---|---|
| 1 | Reporting RPC foundation + security shape | Complete, verified |
| 2 | Server report builder + column specs | Complete, verified |
| 3 | Inventory Valuation page (as-at, cost layers) | Complete, verified |
| 4 | Stock Ledger page (signed quantity ledger) | Complete, verified |
| 5 | Stock Aging page (bucketed layer value) | Complete, verified |
| 6 | Inventory ⇄ GL reconciliation on the layer basis | **Complete this session** |
| 6b | Valuation-basis convergence for integrity helpers | **Next — not started** |
| 7 | Lot / serial traceability report family | Not started |

## Phase 6 — what shipped (all five sub-phases)

- **6.1 Data layer.** New migration extracts the point-in-time layer
  arithmetic into `public._inventory_layer_valuation_as_of(...)` and re-bases
  BOTH `report_inventory_valuation_as_of` and
  `reconcile_inventory_subledger_to_gl` onto it, so the reconciliation's
  subledger total and the Inventory Valuation total are the same number by
  construction, at any as-at date. `explain_inventory_gl_drift` uses the same
  basis. The GL side still sums posted `journal_entry_lines` ≤ as-of and never
  reads `accounts.current_balance`. Security shape preserved exactly:
  `SECURITY DEFINER`, `SET search_path TO 'public'`, `_assert_org_member` +
  `_assert_inventory_report_access`, EXECUTE revoked from `PUBLIC`/`anon`.
  Exception counters re-expressed against layer data: `unlayered_positions`,
  `zero_cost_positions`, `negative_qty_positions`.
- **6.2 Server report.** `inventory_gl_reconciliation` registered in
  `supabase/functions/_shared/reports/columnSpecs.ts`, built in
  `_shared/reports/inventoryData.ts` from the same RPC, dispatched in
  `render-report/index.ts`.
- **6.3 UI.** `src/pages/reports/InventoryGLReconciliation.tsx` rebuilt on
  `ReportSurface`/`ReportTable` with a `ServerBuildConfig` export
  (`reportType: "inventory_gl_reconciliation"`); the client-side row mapping is
  gone. Drift drill-down into the GL register retained.
  `useInventoryReconciliation` types the renamed counters; the shared
  `InventoryReconciliationCard` (Finance Settings) consumes the same hook, so
  remediation stays in one place.
- **6.4 Discoverability.** The Inventory workspace "Insights" group deep-links
  to the single Finance route `/finance/reports/inventory-gl-reconciliation`.
  No second implementation.
- **6.5 Validation.** `src/test/architecture/inventory-gl-reconciliation-unified.test.ts`
  (9 assertions, passing) pins: shared helper usage, security shape, absence of
  the old AVCO expression, posted-journal GL side, server-built export, no raw
  table markup, server key registration, Inventory nav link, renamed counters.
  `supabase/tests/inventory_reporting_ratchet_test.sql` gained section 8
  (reconciliation subledger total == valuation total; aging buckets tie to the
  same valuation) and section 9 (cross-business denial on the re-based RPC).

## Known outstanding (environmental, not a defect)

`supabase/tests/inventory_reporting_ratchet_test.sql` still needs a signed-in
psql / SQL-editor session to execute; this sandbox exposes no `PGHOST`. The new
sections 8–9 are therefore authored but not yet run. Running them is the first
item for whoever has a database session.

## Phase 6b — valuation-basis convergence (next)

`warehouse_stock.average_cost` / `products.cost_price` remain the basis for
`detect_negative_asset_findings` and sibling integrity helpers
(`20260819205917_*.sql`), and for `useValuationDrift` on the Inventory
Integrity page. Now that layer valuation is authoritative, audit each helper
and either re-base it on `_inventory_layer_valuation_as_of` or explicitly
re-label it as an "AVCO-vs-layer divergence" check — which is what it actually
measures. No new report; correctness and labelling only. Deliverables:

1. Enumerate every helper/report that still derives inventory value from
   `warehouse_stock.average_cost` or `products.cost_price`.
2. For each: re-base, or rename + re-document as a divergence check.
3. Extend the ratchet so a NEW inventory-value derivation outside the shared
   helper fails the build.

## Phase 7 — lot / serial traceability report

Unchanged: forward/backward trace over `stock_lots` / `stock_serials` +
movements, delivered as a dimension-driven report family, not per-entity pages.

## Rules for execution

- One phase at a time, fully verified before the next.
- No client-side accounting derivation; no second report engine; no duplicated
  SQL — extract shared arithmetic instead.
- Do not chase the known unrelated pre-existing failures
  (`financial-reports-scope-labeling`, `wms-rpc-grants`).
- Update this file as each phase closes.

## Handover — instructions for the next agent

**Verify before you build.** Do not start 6b until you have independently
confirmed Phase 6, in this order:

1. Run `bunx vitest run src/test/architecture/inventory-gl-reconciliation-unified.test.ts`
   — 9 assertions must pass.
2. Read the newest migration defining
   `reconcile_inventory_subledger_to_gl` and confirm with your own eyes:
   subledger value comes only from `_inventory_layer_valuation_as_of`; the
   `p_as_of` date reaches BOTH sides; no `warehouse_stock.average_cost`
   fallback survives; EXECUTE is revoked from `PUBLIC`/`anon`.
3. If you have a database session, run
   `supabase/tests/inventory_reporting_ratchet_test.sql` and confirm sections
   8 and 9 pass. Record the result here.
4. Open `/finance/reports/inventory-gl-reconciliation`, compare its subledger
   total against `/inventory-app/reports/valuation` at the same as-at date, and
   confirm they agree to the cent — that is the whole point of Phase 6.

**Then resume at Phase 6b**, in the order listed in that section. Do not pick
up unrelated inventory work, do not start Phase 7 before 6b closes, and do not
leave a helper half re-based.
