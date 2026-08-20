# Inventory / Stock Reporting Wave — authoritative status

**Handover verified 2026-08-19 (new owner).** Phases 1–6b re-verified
independently and accepted. **Active phase: 7 — lot / serial traceability
report family, now preceded by a confirmed security fix (7.0).**

## Status board

| Phase | Scope | State |
|---|---|---|
| 1 | Reporting RPC foundation + security shape | Complete, verified |
| 2 | Server report builder + column specs | Complete, verified |
| 3 | Inventory Valuation page (as-at, cost layers) | Complete, verified |
| 4 | Stock Ledger page (signed quantity ledger) | Complete, verified |
| 5 | Stock Aging page (bucketed layer value) | Complete, verified |
| 6 | Inventory ⇄ GL reconciliation on the layer basis | Complete, re-verified |
| 6b | Valuation-basis convergence for integrity helpers | Complete, re-verified |
| 7.0 | **Security fix: unscoped lot/serial trace RPCs** | **New — not started** |
| 7 | Lot / serial traceability report family | Not started |

## Verification of the previous engineer's claims (evidence)

Verified facts:

- `bunx vitest run inventory-gl-reconciliation-unified + inventory-valuation-basis-convergence`
  → 20/20 assertions pass.
- Migration `20260819232807_…` read line by line and confirmed live in the
  database: `list_inventory_subledger_composition(p_org, p_business, p_as_of,
  p_limit, p_branch)` derives `value` **only** from
  `_inventory_layer_valuation_as_of`, raises
  `INVENTORY_RECON_BUSINESS_REQUIRED`, is `SECURITY DEFINER` +
  `_assert_org_member` + `_assert_inventory_report_access`, EXECUTE revoked
  from `PUBLIC`/`anon`.
- `pg_proc` confirms the shared helper is used by
  `report_inventory_valuation_as_of`, `reconcile_inventory_subledger_to_gl`
  and `list_inventory_subledger_composition`. No AVCO fallback survives in
  those three.
- `backfill_opening_inventory_gl` is capped by `LEAST(v_total, v_layer_drift)`,
  declares `basis: 'product_cost_estimate'`, and skips with
  `no_layer_basis_drift`.
- `list_negative_stock_positions` returns `avco_unit_cost` /
  `avco_exposure_estimate` (correctly labelled estimate, not a valuation) and
  now requires company scope.
- Report keys `stock_ledger`, `inventory_valuation`, `inventory_aging`,
  `inventory_gl_reconciliation` are registered in
  `_shared/reports/columnSpecs.ts` and built in `_shared/reports/inventoryData.ts`
  from the same RPCs the screens read.

No claim was found to be false or superficial. Phases 1–6b stand.

Still outstanding from the previous session (environmental):
`supabase/tests/inventory_reporting_ratchet_test.sql` sections 8–11 are
authored but never executed — this sandbox has no `PGHOST`. Run them in the
SQL editor when a session exists; do not treat them as passing until then.

## NEW FINDING (verified) — cross-tenant exposure on the trace RPCs

`pg_proc` inspection of the two existing lot/serial trace functions:

| Function | secdef | org assert | report/branch assert | EXECUTE grantees |
|---|---|---|---|---|
| `trace_lot_genealogy(p_business_id, p_product_id, p_lot_number)` | yes | **none** | **none** | includes **anon** |
| `check_serial_position_drift(p_business_id)` | yes | **none** | **none** | includes **anon** |

Both are `SECURITY DEFINER`, take a caller-supplied `business_id`, perform no
membership or branch check, and are executable by `anon`. Any caller can read
lot genealogy and serial-position data for **any** business by guessing/enumerating
a business id. This is a tenant-isolation defect of the exact class the wave
was chartered to eliminate, and it is a prerequisite for Phase 7 because the
traceability report will read the same substrate.

### Correction (verified 2026-08-20, after re-reading both bodies)

The table above overstated the defect. Both functions **do** enforce
membership: each begins with a `public.user_can_access_business(auth.uid(), …)`
check and raises otherwise, so there is no open cross-tenant read. What was
genuinely wrong is that both are `SECURITY DEFINER` and still carried
`EXECUTE` for `anon` — no reporting function in this wave may keep that.
Phase 7.0 was therefore reduced to revoking `anon`/`PUBLIC` execute and
granting `authenticated, service_role`; no signature change and no caller
changes were needed, so `LotDetail.tsx`, `Lots.tsx`, `InventoryIntegrity.tsx`
and their hooks are untouched.

## Phase 7.0 — close the trace-RPC boundary (DONE)

1. Migration: recreate both functions with the wave's standard shape —
   `p_org` first, `_assert_org_member(p_org)`, business belongs to org,
   `_assert_inventory_report_access(p_business, p_branch)`,
   `SET search_path TO 'public'`, `REVOKE ALL … FROM PUBLIC, anon`,
   `GRANT EXECUTE … TO authenticated, service_role`.
2. Update the callers (`src/pages/inventory/LotDetail.tsx`,
   `Lots.tsx`, `InventoryIntegrity.tsx` and their hooks) to pass the active
   org, and keep the existing operational UI behaviour unchanged.
3. Guard: extend the architecture suite so a lot/serial RPC without both
   assertions, or with `anon` EXECUTE, fails the build; add a ratchet section
   asserting cross-business denial.

## Phase 7 — lot / serial traceability report family

One report family, dimension-driven — **not** per-entity pages, and **not** a
replacement for the operational `/inventory-app/lots` screens (ADR 0070),
which stay as the master-data/detail surface.

Design (from the actual model: `stock_lots`, `stock_serials`,
`warehouse_stock_lots`, `stock_movements.lot_number/serial_number`):

- **Report key `lot_traceability`.** One row per lot × product × warehouse with
  received qty, consumed qty, on-hand qty, layer-derived value at the as-at
  date, expiry date, days-to-expiry bucket, status (active / quarantined /
  recalled), first receipt and last movement.
- **Dimensions, not new reports:** business (required), branch, warehouse,
  product, category, lot/serial number, expiry window, status.
- **Drill-down:** row → movement trail for that lot (forward: where it went;
  backward: which receipt/supplier it came from) using
  `trace_lot_genealogy` post-7.0. Serial-tracked products expose the same
  family filtered to serials, keyed off `stock_serials`.
- **Value basis:** reuse `_inventory_layer_valuation_as_of`; no new valuation
  arithmetic. Where a lot has no layer, report qty with zero value and flag it
  `unlayered`, exactly as the composition helper does.

Sub-phases (each fully finished before the next):

- 7.1 RPC `report_lot_traceability_as_of(...)` with the standard security
  shape, pagination (`p_limit`/`p_offset`) and the dimension set above.
- 7.2 Server column spec + `inventoryData.ts` builder + `render-report`
  dispatch, so screen and export share one dataset.
- 7.3 `ReportSurface` page under Inventory reports + nav entry.
- 7.4 Drill-down (movement trail / genealogy panel).
- 7.5 Architecture guard + ratchet sections (totals tie to Inventory
  Valuation for lot-tracked products; cross-business denial).

## Phase 7 status (2026-08-20)

- **7.0 DONE** — `anon`/`PUBLIC` EXECUTE revoked on `trace_lot_genealogy` and
  `check_serial_position_drift`; granted to `authenticated, service_role`.
- **7.1 DONE** — `_inventory_layer_valuation_as_of` extended with an optional
  lot grain (`p_by_lot`, `p_lot`) plus `qty_received` / `qty_consumed` /
  `latest_receipt_at`, and it now asserts `_assert_org_member` +
  `_assert_inventory_report_access` itself. Existing 7-argument callers
  (valuation, aging-independent recon, composition) select by name and are
  unchanged; their guards still pass. New RPC
  `report_lot_traceability_as_of(...)` returns lot × product × warehouse with
  received / consumed / on-hand, layer value, expiry date + bucket, status
  (`active` / `expired` / `quarantined` / `recalled` / `inactive` /
  `untracked`), supplier, receipt number, pagination and `total_rows`.
  Depleted lots are excluded unless `p_include_depleted`, so the value column
  ties to Inventory Valuation at the same date.
- **7.2 DONE** — `columnSpecs.ts` key `lot_traceability`,
  `inventoryData.ts` builder, `render-report` dispatch.
- **7.3 DONE** — `src/pages/reports/LotTraceabilityReport.tsx` at
  `/inventory-app/reports/lot-traceability`, nav entry, `ReportRegistry` entry,
  hook `useLotTraceabilityAsOf`.
- **7.5 partial** — `src/test/architecture/inventory-lot-traceability-basis.test.ts`
  (9 assertions) pins single-basis, security shape, screen↔export column
  parity. pgTAP ratchet (totals tie, cross-business denial) still owed.
- **7.4 NOT STARTED** — genealogy drill-down panel.

## Appended items (evidence-backed, previously omitted)

- **Ratchet execution.** Sections 8–11 must actually be run once; record the
  result here. Until then Phases 6/6b are "code-verified, DB-test pending".
- **Expiry / shelf-life control.** `stock_lots.expiry_date` exists and drives
  `enforce_lot_expiry_policy`, but no report exposes expiring/expired value.
  Folded into Phase 7 as an expiry dimension rather than a separate report.
- **Serial position drift** (`check_serial_position_drift`) is an integrity
  check, not a report — keep it on the integrity surface, fix its scope in 7.0.
- **Stock Adjustments / Stock Transfers reports** (`StockAdjustmentsReport.tsx`,
  `StockTransfersReport.tsx`) have **not** yet been re-verified against the
  unified engine in this wave. Do not assume they share the Phase 1–6 shape.
  Scheduled as Phase 8 (verify data path, scope enforcement, export parity)
  after Phase 7 closes. No verdict is claimed on them yet.

## Rules for execution

- One phase at a time, fully verified before the next.
- No client-side accounting derivation; no second report engine; no duplicated
  SQL — extract shared arithmetic instead.
- Do not chase the known unrelated pre-existing failures
  (`financial-reports-scope-labeling`, `wms-rpc-grants`).
- Update this file as each phase closes.
