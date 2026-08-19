# Inventory / Stock Reporting — investigation findings and phased plan

Scope: inventory & stock reporting only. Investigation is complete; no code changed.
Everything under "Verified" was confirmed by reading code or querying the live database.

## 1. Verified facts — architecture

- The unified reporting engine is sound and should be preserved. `REPORT_REGISTRY`
  (`src/services/reports/ReportRegistry.ts`) is the single source of report metadata;
  `reportsNav.ts` derives navigation from it; `src/design-system/reports/*`
  (`ReportSurface`, `ReportTable`, `format`, `server.ts`) is the only rendering path;
  exports/PDF are produced server-side by the `render-report` edge function using the
  same column spec (`supabase/functions/_shared/reports/columnSpecs.ts`).
  Architecture tests already forbid raw tables, local formatters, nav drift and
  route/registry drift (`src/test/architecture/reports-*.test.ts`).
- Registry's inventory family contains exactly three reports: `stock-reports`,
  `stock-adjustments-report`, `stock-transfers-report` (`reportsNav.ts:98-102`).
  `inventory-gl-reconciliation` sits in the `integrity` family.
- Verified: `/inventory-app/reports/valuation`, `/aging` and `/integrity`
  (`InventoryValuationReport.tsx`, `StockAgingReport.tsx`,
  `src/pages/inventory/InventoryIntegrity.tsx`) are **not** in `REPORT_REGISTRY`.
  They are outside registry governance: no central permission/feature declaration,
  no server column spec, no nav/route parity test.
- Verified: `columnSpecs.ts` defines only one stock key (`stock_report`, quantity only).
  Every other inventory report therefore exports through the "prebuilt" path, i.e. it
  ships the browser's rows — so the export inherits any client-side row cap.
- Verified: the database already has the correct enterprise-grade substrate — a
  **quantity ledger** (`stock_movements`, immutable, provenance-guarded, reversal-based)
  and a **value ledger** (`cost_layers` + `cost_layer_consumptions`, AVCO/layer costed,
  single registered writer). No inventory reporting RPC exists on top of them:
  there is no `get_stock_ledger`, no `report_inventory_valuation`, nothing.
  All inventory reports query base tables directly from the browser.

## 2. Verified security findings (highest priority)

1. **`check_inventory_valuation_drift(_business_id, _tolerance)`** — SECURITY DEFINER,
   `EXECUTE` granted to `anon` and `authenticated`, and the body contains **no**
   `auth.uid()`, org or business check. Called with no arguments it returns product-level
   quantity, unit cost and inventory value for **every business in every tenant**.
   Cross-tenant disclosure of valuation data. Same no-auth shape:
   `check_valuation_writer_coverage`, `check_movement_reversal_coverage` (metadata only,
   lower severity but still unauthenticated).
2. **`reconcile_inventory_subledger_to_gl(p_org, p_business, p_as_of)`** — SECURITY
   DEFINER, asserts `_assert_org_member(p_org)` only. `p_business` is a caller-supplied
   *filter*, not an authorization check, and `NULL` aggregates all businesses in the org.
   A user authorized for Business A can read Business B's inventory subledger and GL
   inventory balance. Branch is not considered at all.
3. **`cost_layers` / `cost_layer_consumptions` RLS is org-scoped only**
   (`is_org_member(auth.uid(), organization_id)`), not business-scoped — unlike
   `stock_movements`, `warehouse_stock`, `stock_quants`, `stock_adjustments`,
   `stock_transfers`, which are all correctly `user_can_access_business(...)` +
   `can_access_branch(...)`. Any direct read of the value ledger crosses businesses.
4. Client-side `.eq("business_id", ...)` in the report pages is a *filter*, not a
   boundary. It is currently backstopped by correct RLS on the quantity-side tables
   (acceptable defence in depth) but not on the value-side tables (finding 3).

## 3. Verdicts per existing report

| Report | Grain | Verdict | Evidence |
|---|---|---|---|
| Stock Reports (`/inventory-app/reports`, registry `stock-reports`) | qty snapshot | CORRECT for what it is (operational on-hand). MISCLASSIFIED name — "Stock Reports … valuation and movement" describes neither. | `StockReports.tsx:44-58` reads `warehouse_stock` + `products` |
| Inventory Valuation | value | **INCORRECT** | `InventoryValuationReport.tsx:136-176`: `closingValue = currentQty × products.cost_price` — live on-hand and today's AVCO, not "as at period end". No opening balance row. Period in/out valued at `stock_movements.unit_cost`. Ignores `cost_layers` entirely, so it cannot reproduce a historical valuation and cannot tie to GL. |
| Stock Aging | qty only | **INCORRECT** | `StockAgingReport.tsx:68-77`: one "last inbound date" per product applied to the entire on-hand quantity — not layer/lot-aged, so a product with old and new stock ages entirely at its newest receipt. Query has no `.range()`, so it silently truncates at PostgREST's 1000-row cap. No value column. |
| Stock Adjustments Report | qty + value | INCOMPLETE (not incorrect) | `StockAdjustmentsReport.tsx:100-118` — document register with Σ qty × unit_cost. Missing: reversal linkage (`reverses_adjustment_id`), reason grouping, GL journal reference, drill-down. |
| Stock Transfers Report | qty | INCOMPLETE | `StockTransfersReport.tsx` — document register. Missing in-transit exposure (sent vs received) as an accounting figure and value column. |
| Inventory ⇄ GL Reconciliation | value | CORRECT in shape, **INSECURE** (finding 2). Off-engine: hand-rolled cards, not `ReportTable`. | `useInventoryReconciliation.ts:92-109` |
| Inventory Integrity | diagnostics | CORRECT purpose, **INSECURE** (finding 1). Off-engine: raw shadcn `<Table>`. | `InventoryIntegrity.tsx`, `useStockQuants.ts` |
| MISSING | — | **Stock Ledger / product movement card** (opening → movements → closing, per product × warehouse × period) — the report every other inventory report derives from. Also missing: **Lot/Serial traceability** (data exists in `stock_lots`, `stock_serials`, `cost_layers`). |

## 4. Target taxonomy (recommendation)

Research finding (NetSuite saved searches, Odoo `stock.valuation.layer` pivots, BC item
ledger entry + value entry + dimensions): product, category, warehouse, location, branch
and lot/serial are **dimensions**, not reports. Only the *grain* creates a separate
report — quantity ledger vs value ledger vs open documents. This ERP's schema already
matches that split, so the recommendation is a small family set with strong dimensions:

Accounting/control: Inventory Valuation (as-of, from `cost_layers`) · Inventory ⇄ GL
Reconciliation · Adjustment & Write-off Register.
Operational: Stock on Hand / Availability · Stock Ledger (movement card) · Transfer
Register (incl. in-transit) · Lot/Serial Traceability.
Management: Aging / slow-moving · Turnover (later, derived).
Every one of these takes the same dimension set as filters/group-by/drill-down:
business → branch → warehouse → location → category → product → lot/serial.
No new report is justified merely to change grouping level.

## 5. Phases (one complete piece at a time)

**Phase 1 — Security (do first, blocks nothing else).** Add authorization to
`check_inventory_valuation_drift`, `check_valuation_writer_coverage`,
`check_movement_reversal_coverage` (require business membership; revoke `anon`);
enforce `user_can_access_business` + branch inside
`reconcile_inventory_subledger_to_gl` instead of trusting `p_business`; re-scope
`cost_layers` / `cost_layer_consumptions` RLS to business + branch. Add a pgTAP/vitest
suite that explicitly attempts cross-business and cross-tenant reads via each RPC.

**Phase 2 — Server reporting foundation.** Two SECURITY DEFINER, business+branch-enforced
RPCs over the existing ledgers: `report_stock_ledger(...)` (opening/in/out/closing by
quantity, posting-date semantics on `movement_date`, dimension params + pagination) and
`report_inventory_valuation_as_of(...)` (value from `cost_layers` as at a date, with the
quantity/value split explicit). Register both in `columnSpecs.ts` so exports are
server-built rather than prebuilt.

**Phase 3 — Rebuild Inventory Valuation** on Phase 2: true opening → movements →
closing, as-of correctness, value ties to the GL reconciliation figure. Register in
`REPORT_REGISTRY`.

**Phase 4 — New Stock Ledger / movement card** report with drill-down to the source
document, on `ReportSurface`/`ReportTable`, registered.

**Phase 5 — Fix Stock Aging** onto cost layers (age each layer, not the product),
remove the 1000-row truncation, add value buckets, register.

**Phase 6 — Bring Integrity + GL Reconciliation onto the engine** (`ReportTable`,
registry, server export spec) and complete the Adjustment/Transfer registers
(reversal linkage, reason grouping, journal reference, in-transit).

**Phase 7 — Lot/Serial traceability** report.

Dependencies: Phase 2 gates 3/4/5. Phase 1 is independent and should ship alone.

## 6. Validation required per phase

Empty/zero stock · opening balances · date boundaries and backdated periods ·
multi-business, multi-branch, multi-warehouse · adjustments/transfers/purchases/sales ·
large datasets (no silent row caps) · valuation changes and revaluations ·
export/PDF dataset identity with screen · cross-business and cross-branch access
attempts through both the UI path and direct RPC calls.

## 7. Status

Investigation: complete. Implementation: not started. Awaiting approval of Phase 1.
