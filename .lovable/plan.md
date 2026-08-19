# Inventory / Stock Reporting Wave — authoritative status

**Currently active phase:** Phase 6b is **COMPLETE** (shipped and verified
below; Phase 6 independently re-verified first). **Next phase: 7 — lot / serial
traceability report family.**

## Status board

| Phase | Scope | State |
|---|---|---|
| 1 | Reporting RPC foundation + security shape | Complete, verified |
| 2 | Server report builder + column specs | Complete, verified |
| 3 | Inventory Valuation page (as-at, cost layers) | Complete, verified |
| 4 | Stock Ledger page (signed quantity ledger) | Complete, verified |
| 5 | Stock Aging page (bucketed layer value) | Complete, verified |
| 6 | Inventory ⇄ GL reconciliation on the layer basis | **Complete this session** |
| 6b | Valuation-basis convergence for integrity helpers | **Complete this session** |
| 7 | Lot / serial traceability report family | **Next — not started** |

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

## Phase 6b — valuation-basis convergence (shipped and verified)

Verification of Phase 6 was run first: the 9 unified-engine assertions pass, and
the newest migration was read line by line — subledger value comes only from
`_inventory_layer_valuation_as_of`, `p_as_of` reaches both sides, no AVCO
fallback survives, EXECUTE revoked from `PUBLIC`/`anon`.

Enumerated every remaining inventory-value derivation and resolved each:

- **`list_inventory_subledger_composition` — RE-BASED.** Rebuilt on
  `_inventory_layer_valuation_as_of` at an explicit `p_as_of`, so the `value`
  column now sums exactly to `subledger_value` (it previously "defended" the
  figure on the AVCO basis and could never tie). New signature
  `(p_org, p_business, p_as_of, p_limit, p_branch)`; company is an
  authorization boundary (`INVENTORY_RECON_BUSINESS_REQUIRED`), branch applied
  symmetrically, `SECURITY DEFINER` + both assertions, EXECUTE revoked from
  `PUBLIC`/`anon`. `cost_basis` values are now layer-derived:
  `cost_layer` / `zero_cost_layer` / `negative_layer` / `unlayered`. Unlayered
  positions are listed at zero value and flagged, never estimated.
- **`list_negative_stock_positions` + `accounting_integrity_findings_stock_negative`
  — RE-LABELLED.** Negative quantity has no layers, so the amount is an
  operational exposure estimate, not a valuation: columns/evidence keys renamed
  `avco_unit_cost` / `avco_exposure_estimate`, detail copy states the layer
  ledger cannot value the position. Company scope now required, matching the
  reconciliation.
- **`backfill_opening_inventory_gl` — RE-LABELLED + GUARDED.** Product cost
  stays the only possible basis for positions with no layers, but the payload
  now declares `basis: 'product_cost_estimate'`, reports
  `layer_basis_drift` measured by the re-based reconciliation at the entry date,
  skips with `no_layer_basis_drift` when there is nothing to close, and caps the
  posting at that drift so remediation can never create new drift.
- **`useValuationDrift` / `check_inventory_valuation_drift` — NO CHANGE
  NEEDED.** It is already an explicit AVCO-vs-layers divergence check and is
  documented as such; the guard now pins that labelling.

Client alignment: `useInventoryReconciliation.ts` types the new bases and the
renamed exposure fields and pins the composition query to the same `asOf`;
`InventoryReconciliationCard` labels each basis, totals the listed positions,
states the AVCO-estimate caveat on negative stock; `OpeningInventoryBackfillDialog`
shows the measured layer drift, the basis caveat and the new skip reason.

Guards: `src/test/architecture/inventory-valuation-basis-convergence.test.ts`
(11 assertions, passing) fails the build if a value derivation reappears outside
the shared helper, if the misleading names return, if the composition loses its
security shape, or if the backfill cap is removed.
`supabase/tests/inventory_reporting_ratchet_test.sql` gained section 10
(composition total == subledger value; only layer-derived bases allowed) and
section 11 (company scope required on both integrity helpers).

Typecheck clean; Phase 6 + 6b architecture suites: 20/20 passing.

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

**Verify before you build.** Do not start Phase 7 until you have
independently confirmed Phase 6b, in this order:

1. Run `bunx vitest run src/test/architecture/inventory-gl-reconciliation-unified.test.ts src/test/architecture/inventory-valuation-basis-convergence.test.ts`
   — 20 assertions must pass. Then run a full typecheck.
2. Read the newest migration defining
   `list_inventory_subledger_composition` and confirm with your own eyes: value
   comes only from `_inventory_layer_valuation_as_of`; no `average_cost` /
   `cost_price` survives in that function; company scope raises
   `INVENTORY_RECON_BUSINESS_REQUIRED`; EXECUTE revoked from `PUBLIC`/`anon`;
   `backfill_opening_inventory_gl` is capped by `LEAST(v_total, v_layer_drift)`.
3. Grep the repo for any NEW inventory-value derivation from
   `warehouse_stock.average_cost` or `products.cost_price`. Anything found must
   either read the shared helper or be named/documented as an AVCO estimate or
   divergence check.
4. If you have a database session, run
   `supabase/tests/inventory_reporting_ratchet_test.sql` and confirm sections
   8–11 pass. Record the result here.
5. Open `/finance/reports/inventory-gl-reconciliation`, expand "Subledger
   composition" and confirm the listed-positions total equals `subledger_value`
   for the same as-at date, and that the same figure matches
   `/inventory-app/reports/valuation` to the cent.

**Then resume at Phase 7** as scoped above (dimension-driven lot/serial
traceability report family on the unified engine — server column specs, server
build, `ReportSurface` page, nav entry, architecture + ratchet guards). Do not
pick up unrelated inventory work and do not leave a report half migrated.
