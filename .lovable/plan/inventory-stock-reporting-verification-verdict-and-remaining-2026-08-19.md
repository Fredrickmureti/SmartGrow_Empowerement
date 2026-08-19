# Inventory / Stock Reporting — verification verdict and remaining phases

Scope unchanged: inventory & stock reporting only. This revision replaces the
"implementation not started" status with an independently verified account of
what the previous engineer actually landed, plus the corrected phase order.

## 1. Verification of claimed work (checked against live DB and code)

| Claim | Verdict | Evidence |
|---|---|---|
| `report_stock_ledger` exists, definer, business+branch enforced, paginated | TRUE | `pg_proc`: SECURITY DEFINER, `search_path=public`, args `(p_org,p_business,p_date_from,p_date_to,p_branch,p_warehouse,p_product,p_category,p_limit,p_offset)`, body calls `_assert_inventory_report_access` |
| `report_inventory_valuation_as_of` same shape, replays cost layers | TRUE | same, body references `cost_layer_consumptions` |
| `_assert_inventory_report_access` rejects NULL business, checks branch | TRUE | delegates to `_assert_inventory_diag_business` (auth.uid, NULL-business reject, `user_can_access_business`) + `can_access_branch` |
| Diagnostics (`check_inventory_valuation_drift`, `check_valuation_writer_coverage`, `check_movement_reversal_coverage`) authorized | TRUE for the guard | drift → `_assert_inventory_diag_business`; coverage fns → `_assert_inventory_diag_authenticated` |
| `cost_layers` / `cost_layer_consumptions` RLS re-scoped to business | TRUE | RLS enabled; policies `cost_layers_select_business_scoped`, `cost_layer_consumptions_select_business` both business-scoped |
| Deno builder + column specs + `render-report` dispatch | TRUE | `_shared/reports/inventoryData.ts` (195 lines), `columnSpecs.ts` keys `stock_ledger`/`inventory_valuation`, `render-report/index.ts:71,462` |
| SQL ratchet test added | TRUE (file exists), but it **fails today** — see defect A |
| Phase 1 "security" complete | **FALSE — incomplete** | defects A and B below |
| Plan updated / Phase 3+ started | FALSE | pages untouched; not in registry |

## 2. Confirmed open defects (introduced or left behind)

**A. `anon` still holds EXECUTE on every inventory reporting/diagnostic RPC.**
Verified via `has_function_privilege('anon', oid, 'EXECUTE')` = true for
`report_stock_ledger`, `report_inventory_valuation_as_of`,
`check_inventory_valuation_drift`, `check_valuation_writer_coverage`,
`check_movement_reversal_coverage`, `reconcile_inventory_subledger_to_gl`.
The default `GRANT EXECUTE TO PUBLIC` was never revoked. Data does not leak
(the in-body guards raise on `auth.uid() IS NULL`), so severity is
defence-in-depth, not disclosure — but the shipped ratchet test asserts the
opposite and therefore fails, i.e. the regression gate is currently red.

**B. Duplicate `reconcile_inventory_subledger_to_gl` overloads.**
Both `(p_org, p_business, p_as_of)` and `(p_org, p_business, p_as_of, p_branch)`
exist. The legacy 3-arg version is still callable and branch-blind; leaving two
resolutions of one control report is exactly the "second source of truth" the
brief forbids. Drop the 3-arg form after confirming no caller uses it.

**C. Report pages still read the wrong sources.** `src/pages/reports/InventoryValuationReport.tsx`
and `StockAgingReport.tsx` are unchanged: valuation is still live on-hand x
current AVCO, aging is still one date per product with no `.range()`. The new
RPCs are consumed only by the export path, so **screen and PDF now disagree** —
a new inconsistency created by landing Phase 2 without Phase 3.

## 3. Corrected phase order

**Phase 1b (do first, small).** Revoke `EXECUTE` from `anon` (and `PUBLIC`) on
the six functions in defect A, grant explicitly to `authenticated` +
`service_role`; drop the legacy 3-arg `reconcile_inventory_subledger_to_gl`
after a caller sweep. Then run `supabase/tests/inventory_reporting_ratchet_test.sql`
and require a clean PASS.

**Phase 3 (next).** Rebuild `InventoryValuationReport` on
`report_inventory_valuation_as_of` via the unified engine
(`ReportSurface`/`ReportTable`, `toReportColumns`/`toReportRows`), as-of date
semantics, opening/closing explicit, register in `REPORT_REGISTRY` with the
`inventory_valuation` server key so screen and export are one dataset.

**Phase 4.** New Stock Ledger / movement card page on `report_stock_ledger`,
registered, with drill-down to the source document.

**Phase 5.** Fix Stock Aging onto cost layers (age each layer, not the product),
remove the 1000-row truncation, add value buckets, register.

**Phase 6.** Bring Integrity + Inventory⇄GL Reconciliation onto the engine and
complete the Adjustment/Transfer registers (reversal linkage, reason grouping,
journal reference, in-transit).

**Phase 7.** Lot/Serial traceability report.

Dimensions stay dimensions: business → branch → warehouse → location → category
→ product → lot/serial are filters/group-by on the families above, never new
reports. (Section 4 of the prior revision remains the accepted taxonomy.)

## 4. Validation per phase

Empty/zero stock · opening balances · backdated and boundary dates · multi
business/branch/warehouse · large datasets (no silent caps) · screen-vs-PDF
dataset identity · explicit cross-business and cross-branch attempts through
both the UI path and direct RPC calls · ratchet test green.

## 5. Status

Phase 1: substantially done, **two defects open (A, B)**. Phase 2: done
server-side. Phase 3 onward: not started. Next action: Phase 1b.
