# Inventory / Stock Reporting Wave — authoritative status

**Handover verification: complete.** Phases 1–5 are genuinely implemented
(evidence below). Phase 6 has NOT started, and verification surfaced two new
confirmed defects that Phase 6 must fix, plus one new phase (6b).

**Currently active phase:** Phase 6 — Inventory ⇄ GL reconciliation onto the
authoritative cost-layer valuation basis.

## Verification of prior work (facts, re-checked in this codebase)

- **Phase 1 (RPC foundation + security) — CONFIRMED.**
  `supabase/migrations/20260819214418_*.sql` defines
  `report_stock_ledger` and `report_inventory_valuation_as_of` as
  `STABLE SECURITY DEFINER`, `SET search_path TO 'public'`, asserting
  `_assert_org_member` + `_assert_inventory_report_access` (business =
  authorization boundary; explicit branch checked via `can_access_branch`;
  branch-null rows row-guarded). Quantity direction comes from
  `stock_movement_signed_quantity`. Period is mandatory and validated.
- **Phase 2 (server builder) — CONFIRMED.** `columnSpecs.ts` carries
  `stock_ledger`, `inventory_valuation`, `inventory_aging`;
  `render-report/index.ts` dispatches all three through
  `_shared/reports/inventoryData.ts`.
- **Phases 3–5 (Valuation / Stock Ledger / Stock Aging pages) — CONFIRMED.**
  All three pages exist, read only the RPCs through
  `src/hooks/inventory/useInventoryReportRpcs.ts` (paging on `total_rows`),
  and type their export as `ServerBuildConfig`. No `products.stock_quantity`,
  `warehouse_stock` or `qty × cost_price` derivation remains in these pages.
  All three are registered, routed, and present in the Inventory sidebar.
- **Outstanding from before (environmental, not a defect):**
  `supabase/tests/inventory_reporting_ratchet_test.sql` still needs a signed-in
  psql/SQL-editor session; this sandbox has no `PGHOST`.

## New confirmed findings (this handover)

1. **Two valuation sources of truth (CRITICAL, accounting).**
   `report_inventory_valuation_as_of` values stock from `cost_layers` +
   `cost_layer_consumptions` reconstructed at the as-of date. But
   `reconcile_inventory_subledger_to_gl`
   (`supabase/migrations/20260819213514_*.sql`, line ~276) values the subledger
   as `ws.quantity × COALESCE(NULLIF(ws.average_cost,0), p.cost_price, 0)`.
   Consequence: the Inventory Valuation report and the Inventory ⇄ GL
   reconciliation can disagree for the same business and date, so "drift"
   reported against the GL is not attributable — it may be layer-vs-AVCO
   divergence rather than a missing journal. `useInventoryReconciliation`
   documents the AVCO basis as the contract (ADR 0017); that contract is now
   superseded by the cost-layer ledger (ADR 0078) and must be re-based.
2. **Reconciliation has no true as-of.** The subledger side reads the *current*
   `warehouse_stock` snapshot, while the GL side sums posted
   `journal_entry_lines` up to `p_as_of`. Any historical date therefore compares
   today's stock to a past ledger — a structurally guaranteed false drift. The
   as-of date input on `InventoryGLReconciliation.tsx` is misleading today.
3. **Reconciliation report bypasses the unified server export.**
   `src/pages/reports/InventoryGLReconciliation.tsx` builds a client-side
   `ExportConfig` (rows mapped in the browser) while Phases 3–5 export
   server-built via `reportType`. Same figure, two code paths.
4. **Reconciliation is reachable only from Finance.** It is registered at
   `/finance/reports/inventory-gl-reconciliation`; the Inventory workspace
   "Integrity" entry points at `src/pages/inventory/InventoryIntegrity.tsx`
   (quant/valuation/serial drift checks), which is a *different, correct*
   report. This is a discoverability gap, not a duplicate report.

## Phase 6 — Inventory ⇄ GL reconciliation (active)

Goal: one reconciliation figure, derived from the same authoritative layer
arithmetic as Inventory Valuation, correct at any as-of date, exported through
the unified engine.

- **6.1 Data layer.** Rewrite `reconcile_inventory_subledger_to_gl(p_org,
  p_business, p_as_of)` so the subledger side is computed from the same
  layer CTE used by `report_inventory_valuation_as_of` (extract that
  arithmetic into one `_inventory_layer_valuation_as_of(...)` helper so the
  two RPCs cannot drift again). GL side unchanged (posted
  `journal_entry_lines` ≤ as-of; never `accounts.current_balance`).
  Keep exception counters, but re-express them against layer data
  (`zero_cost_layers`, `negative_qty_positions`, `unlayered_positions` — the
  last one replaces "fallback at product cost" and is the honest measure of
  positions the layer ledger cannot value). Preserve the security shape of
  Phase 1 exactly: SECURITY DEFINER, pinned `search_path`, `_assert_org_member`
  + `_assert_inventory_report_access`, EXECUTE revoked from `PUBLIC`/`anon`.
  Entity-level by design — document that branch is not a dimension here.
- **6.2 Server report.** Add an `inventory_gl_reconciliation` key to
  `columnSpecs.ts` and a builder branch in `_shared/reports/inventoryData.ts`
  reading the same RPC; add the `render-report` dispatch.
- **6.3 UI.** Point `useInventoryReconciliation` at the re-based RPC (types
  updated for the renamed counters), render the grid through
  `ReportSurface`/`ReportTable` like Phases 3–5, and replace the client
  `ExportConfig` with a `ServerBuildConfig` (`reportType:
  "inventory_gl_reconciliation"`). Keep the drift drill-down into the GL
  register. `InventoryReconciliationCard` (used in Finance Settings) keeps
  consuming the same hook, so remediation logic stays in one place.
- **6.4 Discoverability.** Register the report in the Inventory workspace
  reporting nav as well, pointing at the single existing route — no second
  implementation.
- **6.5 Validation.** Extend
  `supabase/tests/inventory_reporting_ratchet_test.sql` to assert, for the
  same business/date: reconciliation `subledger_value` total ==
  `report_inventory_valuation_as_of` total == sum of the four aging buckets.
  Add a cross-business/cross-branch denial assertion for the re-based RPC and
  a client-side guard test that this page exports server-built.

## Phase 6b — Valuation-basis convergence (NEW, from finding 1)

`warehouse_stock.average_cost` / `products.cost_price` remain the basis for
`detect_negative_asset_findings` and other integrity helpers
(`20260819205917_*.sql`). Once 6.1 lands, layer valuation is authoritative:
audit those helpers and re-base or explicitly re-label them as
"AVCO-vs-layer divergence" checks (which is what `useValuationDrift` on the
Integrity page already measures). No new report; correctness only.

## Phase 7 — Lot / serial traceability report

Unchanged: forward/backward trace over `stock_lots` / `stock_serials` +
movements, as a dimension-driven report family, not per-entity pages.

## Rules for execution

- One phase at a time, fully verified before the next.
- No client-side accounting derivation; no second report engine; no duplicated
  SQL — extract shared arithmetic instead.
- Do not chase the known unrelated pre-existing failures
  (`financial-reports-scope-labeling`, `wms-rpc-grants`).
- Update this file as each phase closes.
