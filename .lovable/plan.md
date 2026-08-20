# Inventory / Stock Reporting Wave — authoritative status

**Last updated 2026-08-20 00:25 UTC.** Supersedes
`.lovable/plan/inventory-stock-reporting-wave-authoritative-status-2026-08-20.md`
(kept for the audit trail). This file is the single source of project status.

**Active phase: 7 — lot / serial traceability. 7.0–7.3 are DONE and verified.
Next milestone: 7.4 (genealogy / movement-trail drill-down).**

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
| 7.0 | Security: revoke `anon` EXECUTE on lot/serial trace RPCs | **DONE, verified** |
| 7.1 | `report_lot_traceability_as_of` + lot grain in the shared helper | **DONE, verified** |
| 7.2 | Server column spec + builder + `render-report` dispatch | **DONE, verified** |
| 7.3 | Lot Traceability page + route + nav + registry | **DONE, verified** |
| 7.4 | Genealogy / movement-trail drill-down | **NEXT — not started** |
| 7.5 | pgTAP ratchet sections for Phase 7 | Pending (needs a DB session) |
| 8 | Re-verify Stock Adjustments / Stock Transfers reports against the unified engine | Not started, no verdict claimed |

## Correction to the previous record (verified fact)

The earlier plan claimed `trace_lot_genealogy` and `check_serial_position_drift`
were **unscoped cross-tenant reads**. That is **false**: both call
`user_can_access_business(auth.uid(), …)` and raise on failure. The real defect
was narrower — `EXECUTE` was granted to `PUBLIC`/`anon` on `SECURITY DEFINER`
functions. That is now revoked (`authenticated, service_role` only), so **no
signature change and no caller changes were needed**; the operational
`Lots.tsx` / `LotDetail.tsx` / `InventoryIntegrity.tsx` surfaces are untouched.

## What is implemented and verified (Phase 7.0–7.3)

Database (migration applied; also recorded in `supabase/migrations`):

- `trace_lot_genealogy(uuid,uuid,text)` and `check_serial_position_drift(uuid)`:
  `REVOKE ALL … FROM PUBLIC, anon`; `GRANT EXECUTE … TO authenticated,
  service_role`. Confirmed in `pg_proc.proacl`.
- `_inventory_layer_valuation_as_of(p_org, p_business, p_as_of, p_branch,
  p_warehouse, p_product, p_category, p_by_lot, p_lot)` — the ONE as-at layer
  valuation basis, now with an **optional** lot grain and
  `qty_received` / `qty_consumed` / `latest_receipt_at`. It asserts
  `_assert_org_member` + `_assert_inventory_report_access` itself. Existing
  7-argument callers (valuation, aging, reconciliation, composition) select by
  column name and are unaffected.
- `report_lot_traceability_as_of(p_org, p_business, p_as_of, p_branch,
  p_warehouse, p_product, p_category, p_lot, p_status, p_expiry_bucket,
  p_include_depleted, p_limit, p_offset)` — lot × product × warehouse with
  received / consumed / on-hand, layer value, unit cost, expiry date +
  bucket (`expired`/`0_30`/`31_60`/`61_90`/`90_plus`/`none`), status
  (`recalled` > `quarantined` > `expired` > `untracked` > `inactive` >
  `active`), supplier, receipt, first receipt, last movement, `total_rows`.
  `SECURITY DEFINER`, `SET search_path`, both assertions, business required,
  `anon` revoked. Depleted lots are hidden unless `p_include_depleted`, so the
  **value column ties to Inventory Valuation at the same date**.

Application:

- `supabase/functions/_shared/reports/columnSpecs.ts` → `lot_traceability` spec.
- `supabase/functions/_shared/reports/inventoryData.ts` → key, filters
  (`lotNumber`, `lotStatus`, `expiryBucket`, `includeDepleted`) and builder.
- `supabase/functions/render-report/index.ts` → `lot_traceability` dispatched
  down the inventory path, so screen and PDF/CSV/XLSX share one dataset.
- `src/hooks/inventory/useInventoryReportRpcs.ts` → `useLotTraceabilityAsOf`
  with `LotTraceabilityRow` / `LotTraceabilityFilters` and page-through.
- `src/pages/reports/LotTraceabilityReport.tsx` → `ReportSurface` page with
  as-at date, lot/serial, status and expiry filters, branch scope toggle,
  Lot Value / Expiry Risk / Blocked Value cards, server-built export.
- Route `/inventory-app/reports/lot-traceability`, Insights nav entry, and a
  `ReportRegistry` entry (`reportType: "lot_traceability"`).

Verification evidence:

- `bunx vitest run inventory-lot-traceability-basis + inventory-valuation-basis-convergence
  + inventory-gl-reconciliation-unified` → **27/27 pass**.
- New guard `src/test/architecture/inventory-lot-traceability-basis.test.ts`
  pins: value from the shared helper only (no second layer aggregation, no
  AVCO/cost-price), both assertions + `anon` revokes, depleted-lots default,
  page↔spec column parity, and end-to-end export registration.
- `tsgo --noEmit` clean.
- `pg_proc` confirms the three functions exist with the expected signatures and
  `authenticated`/`service_role`-only ACLs.

## What is still pending

1. **7.4 — genealogy / movement-trail drill-down (NEXT).** Row → panel showing
   backward trace (receipt, supplier, PO/GRN) and forward trace (issues, sales,
   transfers) for that lot, using `trace_lot_genealogy` post-7.0. Serial-tracked
   products expose the same family filtered to serials off `stock_serials`.
2. **7.5 — pgTAP ratchet** sections for Phase 7: lot totals tie to Inventory
   Valuation at the same date for lot-tracked products, and cross-business
   denial on `report_lot_traceability_as_of`.
3. **Ratchet execution (carried over).**
   `supabase/tests/inventory_reporting_ratchet_test.sql` sections 8–11 are
   authored but never executed (no `PGHOST` in this sandbox, and the SQL runner
   role cannot EXECUTE the hardened functions). Until run, Phases 6/6b remain
   "code-verified, DB-test pending".
4. **Live smoke of the new RPC** could not be re-run this session: the SQL
   runner is neither `authenticated` nor `service_role`, so it is denied by
   design, and preview auth is `external_unmanaged` (no session can be minted).
   Earlier session observed lot `LOT-20260819`: 1,200 received, 25 consumed,
   1,175 on hand, 49,350 value, expiry 2026-11-19, status `active`.
5. **Phase 8** — Stock Adjustments / Stock Transfers reports have **not** been
   re-verified against the unified engine. No verdict claimed.

## Instructions for the next agent

1. **Verify before building.** Re-run
   `bunx vitest run src/test/architecture/inventory-lot-traceability-basis.test.ts
   src/test/architecture/inventory-valuation-basis-convergence.test.ts
   src/test/architecture/inventory-gl-reconciliation-unified.test.ts` and
   `tsgo --noEmit`. Then confirm in `pg_proc` that
   `report_lot_traceability_as_of`, `_inventory_layer_valuation_as_of`,
   `trace_lot_genealogy` and `check_serial_position_drift` are
   `SECURITY DEFINER`, carry `SET search_path`, and grant EXECUTE only to
   `authenticated`/`service_role`. Read the Lot Traceability page and confirm it
   contains no value arithmetic of its own.
2. **Note on repo/DB drift.** A prior session's file writes were lost while its
   migration stayed applied; the migration file has been re-recorded from
   `pg_get_functiondef`. If you find a function in the DB with no migration
   file, re-record it the same way rather than inventing new SQL.
3. **Then resume at 7.4**, then 7.5, and only after Phase 7 closes move to
   Phase 8. Do not start unrelated work.

## Rules for execution (unchanged)

- One phase at a time, fully finished and verified before the next.
- No client-side accounting derivation; no second report engine; no duplicated
  SQL — extend the shared helper instead.
- Screen and export always read the same RPC.
- Ignore the pre-existing project-wide linter noise (thousands of
  `SECURITY DEFINER` EXECUTE warnings) and the known unrelated failures
  (`financial-reports-scope-labeling`, `wms-rpc-grants`).
- Update this file as each phase closes.
