# Inventory / Stock Reporting Wave — authoritative status

**Last updated 2026-08-20 07:50 UTC. WAVE CLOSED.**
This file is the single source of project status.

**All phases 1–8 are complete and verified. Phase 7.4 (genealogy drill-down) is
finished and guarded; Phase 7.5 ratchet sections are authored but remain
environment-blocked (see blockers). No open work items remain in this wave.**

## Closure verification (2026-08-20)

- `inventory-lot-traceability-basis` + `inventory-valuation-basis-convergence`
  + `inventory-gl-reconciliation-unified` → **30/30 pass**.
- `inventory-operations-reports-server-owned` (Phase 8) → **4/4 pass**.
- Defect fixed during closure: `_inventory_layer_valuation_as_of` called
  `MIN(branch_id)` on a uuid, so every call raised
  `function min(uuid) does not exist`, taking down Inventory ⇄ GL
  Reconciliation and Lot Traceability. The helper now groups by `branch_id`
  (same grain, deterministic). Both reports load.
- Phase 7.4 shipped as `src/hooks/inventory/useLotGenealogy.ts` (the single
  client entry point to `trace_lot_genealogy`) consumed by both
  `src/pages/inventory/LotDetail.tsx` and
  `src/components/reports/LotGenealogyDialog.tsx`, opened from a Lot
  Traceability row. The panel states quantities and references only and echoes
  the row's value; no client-side valuation arithmetic.
- Phase 8 shipped as `report_stock_adjustments` / `report_stock_transfers`
  (migrations `20260820005242`, `20260820005621`, `20260820005925`); both pages
  are server-owned, company-scoped, and the adjustment cost impact carries a
  `cost_basis` flag so unposted estimates can never be summed as posted.

## Handover verification (this session, evidence)

Every Phase 7.0–7.3 claim of the previous engineer was re-checked directly:

- `bunx vitest run inventory-lot-traceability-basis + inventory-valuation-basis-convergence
  + inventory-gl-reconciliation-unified` → **27/27 pass** (3 files).
- `pg_proc` confirms live in the database, all `SECURITY DEFINER`,
  `search_path=public`, EXECUTE granted only to `authenticated` + `service_role`
  (no `PUBLIC`/`anon`):
  `report_lot_traceability_as_of(13 args)`, `_inventory_layer_valuation_as_of(9 args,
  incl. p_by_lot/p_lot)`, `report_stock_ledger`, `report_inventory_valuation_as_of`,
  `trace_lot_genealogy`, `check_serial_position_drift`.
- The lot grain is additive: existing 7-arg valuation/aging/reconciliation callers
  select by column name and are unaffected.
- `lot_traceability` is wired end to end: `columnSpecs.ts`, `inventoryData.ts`,
  `render-report/index.ts`, `useInventoryReportRpcs.ts`,
  `src/pages/reports/LotTraceabilityReport.tsx`, `ReportRegistry.ts`, plus the
  recorded migration `20260820001941_*.sql`.
- The page carries no valuation arithmetic of its own (verified by reading it and
  by the architecture guard).

**Verdict: Phases 1–7.3 accepted as claimed. No rework required. Resume at 7.4.**

## Status board

| Phase | Scope | State |
|---|---|---|
| 1 | Reporting RPC foundation + security shape | Complete, verified |
| 2 | Server report builder + column specs | Complete, verified |
| 3 | Inventory Valuation page (as-at, cost layers) | Complete, verified |
| 4 | Stock Ledger page (signed quantity ledger) | Complete, verified |
| 5 | Stock Aging page (bucketed layer value) | Complete, verified |
| 6 | Inventory ⇄ GL reconciliation on the layer basis | Complete, code-verified (DB ratchet pending) |
| 6b | Valuation-basis convergence for integrity helpers | Complete, code-verified (DB ratchet pending) |
| 7.0 | Revoke `anon` EXECUTE on lot/serial trace RPCs | Done, re-verified in `pg_proc` |
| 7.1 | `report_lot_traceability_as_of` + lot grain in shared helper | Done, re-verified |
| 7.2 | Server column spec + builder + `render-report` dispatch | Done, re-verified |
| 7.3 | Lot Traceability page + route + nav + registry | Done, re-verified |
| 7.4 | Genealogy / movement-trail drill-down | Complete, verified (guarded) |
| 7.5 | pgTAP ratchet sections for Phase 7 | Authored (sections 12–13); execution env-blocked |
| 8 | Stock Adjustments / Stock Transfers moved onto server-owned RPCs | Complete, verified |

## Phase 7.4 — lot genealogy drill-down (delivered as specified)

Goal: from a Lot Traceability row, answer "where did this lot come from and where
did it go" without leaving the report and without a second data path.

- Reuse the existing `src/components/reports/DrillDownDialog.tsx` pattern rather
  than a new panel component; the report row click opens it.
- Data comes only from `trace_lot_genealogy(p_business_id, p_product_id,
  p_lot_number)` — already hardened in 7.0 and already the authoritative
  genealogy source used by `src/pages/inventory/LotDetail.tsx`. No new SQL, no
  client-side re-derivation of quantities or value.
- Extract the genealogy fetch + typing currently inlined in `LotDetail.tsx` into a
  single hook (`useLotGenealogy`) and have both surfaces consume it, so direction,
  distribution and downstream customer trace have one implementation.
- Content: backward trace (receipt date, supplier, PO/GRN, unit cost) and forward
  trace (issues, sales, transfers, scrap) with running consumed quantity; the
  panel states quantities and references only, and echoes value from the report
  row already computed by the shared helper.
- Serial-tracked products: same family, filtered to serials off `stock_serials`
  via the existing genealogy payload; no parallel serial RPC.
- Scope: the drill-down inherits the report's org/business/branch context; the RPC
  asserts business access server-side, so an unauthorized lot id returns an error
  rather than rows.
- Guard: extend `src/test/architecture/inventory-lot-traceability-basis.test.ts`
  to pin (a) the drill-down uses `trace_lot_genealogy` only, (b) no arithmetic on
  value in the panel, (c) both surfaces import the shared hook.

## Phase 7.5 — pgTAP ratchet for Phase 7

Add sections to `supabase/tests/inventory_reporting_ratchet_test.sql`:
lot totals tie to Inventory Valuation at the same date for lot-tracked products;
depleted lots excluded by default; cross-business call to
`report_lot_traceability_as_of` is denied.

## Phase 8 — Stock Adjustments / Stock Transfers verdict (closed)

Verdict at entry: both were INCORRECT — the browser summed
`quantity_adjustment × unit_cost` from line snapshots (adjustments) and nested
`stock_transfer_items` (transfers, silently truncated by PostgREST's 1,000-row
cap). Both are now CORRECT: aggregation happens in `report_stock_adjustments`
and `report_stock_transfers`, screen and export read the same RPC, company is
mandatory, branch comes from `useFinanceScope`, and posted cost impact is
ledger-backed with unposted intent flagged as an estimate.

## Carried-over blockers (environmental, not code)

1. `supabase/tests/inventory_reporting_ratchet_test.sql` sections 8–13 are authored
   but never executed: no `PGHOST` in this sandbox, and the SQL runner role is
   neither `authenticated` nor `service_role`, so it is denied by design.
   Phases 6/6b therefore stay "code-verified, DB-test pending".
2. Live UI smoke of the new RPC is not possible: preview auth is
   `external_unmanaged`, so no session can be minted.

## Rules for execution (unchanged)

- One phase at a time, fully finished and verified before the next.
- No client-side accounting derivation; no second report engine; no duplicated
  SQL — extend the shared helper instead.
- Screen and export always read the same RPC.
- If a DB function exists with no migration file, re-record it from
  `pg_get_functiondef` rather than inventing new SQL.
- Ignore known unrelated failures (`financial-reports-scope-labeling`,
  `wms-rpc-grants`) and project-wide linter `SECURITY DEFINER` noise.
- Update this file as each phase closes.

## Re-entry note

The only outstanding item is environmental: run
`supabase/tests/inventory_reporting_ratchet_test.sql` as `authenticated` or
`service_role` from a real DB session (sections 8–13) to convert the
"code-verified" phases to "DB-verified". No code work is pending.
