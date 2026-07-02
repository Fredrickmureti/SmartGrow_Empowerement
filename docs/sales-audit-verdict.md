# Sales Module — Zero-Trust Audit Verdict

Companion to `docs/sales-audit.md`. This file is the structured pass/fail
verdict produced by the Phase-C audit checks. Each row cites file + line +
the Odoo behavior we are aligning to. Empty buckets are still listed so a
future agent can see they were intentionally checked.

## Method

Phase-C check matrix (see plan):

1. Dual-scope filter (org + business) — already enforced workspace-wide by
   `src/test/architecture/business-scoped-queries.test.ts`.
2. Branch filter on every Sales read — `applyBranchFilter` from
   `src/lib/branchScope.ts`, with `branchId` in the React Query key.
3. Branch stamping on every Sales insert — already enforced workspace-wide
   by `src/test/architecture/branch-id-stamping.test.ts`.
4. Customer scope — pickers must be `business_id`-filtered.
5. Invoice → JE atomicity — `confirm_invoice_atomic` RPC.
6. Payment → invoice atomicity — `record_payment_atomic` family.
7. SO → Inventory atomicity — `complete_delivery_atomic`,
   `release_sales_order_reservations_atomic`.
8. Reporting — `useGeneralLedger`, `useAccountBalances`,
   `useCustomerStatements` accept and respect active branch.
9. Contamination simulation — query-key + filter inspection per hook.
10. Architecture guard tests — extended where needed.

## ✅ Correct (Odoo-grade, no change needed)

| Area | Evidence | Odoo reference |
|---|---|---|
| Invoices list/insert | `src/hooks/useInvoices.ts:86,158` — `applyBranchFilter` + `branch_id` stamped, key partitioned by `currentBranch?.id` | account.move scoped per company; branch is operational filter |
| Invoices paginated + KPIs | `src/hooks/useInvoicesPaginated.ts:51,83,171,251` — branchId in key, branch filter on list and stats, stamp on insert | same |
| Sales orders | `src/hooks/useSalesOrders.ts:68,86,130,354,380` — read-filter + stamp on create + **pulls `branch_id` from the SO row** (not current context) when converting to invoice | sale.order → account.move keeps SO's branch |
| Estimates | `src/hooks/useEstimates.ts:79,101,141` | sale.order quotation state |
| Delivery notes | `src/hooks/useDeliveryNotes.ts:56,74,111` | stock.picking |
| Credit notes | `src/hooks/useCreditNotes.ts:117,170` | account.move refund |
| Sales returns | `src/hooks/useSalesReturns.ts:72,91,154` | stock.return.picking |
| Customer payments | `src/hooks/usePayments.ts:63` (read) — write paths go through `record_payment_atomic` family of RPCs | account.payment |
| Customer statements | `src/hooks/useCustomerStatements.ts:78–283` — every sub-query (current invoices, payments, credit notes, prior-period roll-forward, outstanding, advances) is branch-filtered and the report key is partitioned by `branchId` | account.report customer ledger with branch filter |
| Proforma invoices | `src/hooks/useProformaInvoices.ts:59,77,115,214` — branch filter + stamp on both proforma and conversion | sale.order with `state='sent'` |
| Recurring invoices | `src/hooks/useRecurringInvoices.ts:62,82,107,196,204` — generated invoices inherit the **template's** `branch_id`, not the caller's active branch | account.move template scoping |
| Invoice integrity check | `src/hooks/useInvoiceValidation.ts:34–99` — org+business scoped; intentionally branch-agnostic because integrity checks are a company-level concern | account.move audit views are company-wide |
| Customer credit checks | `src/hooks/useCustomerCredit.ts:25–160` — org+business scoped; intentionally branch-agnostic because credit limits and outstanding A/R are a customer/company concern, not a branch concern | res.partner credit fields are company-level |
| Atomic write paths | All confirmation/conversion/payment paths go through SECURITY DEFINER RPCs (`confirm_invoice_atomic`, `convert_estimate_to_so_atomic`, `convert_so_to_invoice_atomic`, `complete_delivery_atomic`, `record_payment_atomic`, `apply_credit_to_invoice_atomic`, `restore_invoice_stock_atomic`, `release_sales_order_reservations_atomic`) | Odoo wraps state transitions in a single transaction with downstream side-effects |
| Cross-business write triggers | DB-side triggers (documented in `docs/sales-audit.md`) reject mismatched-business writes on invoices, payments, deliveries, SO→invoice, proforma→invoice, POS→credit-invoice | Odoo company-rule + record-rule enforcement |

## ⚠️ Partially correct (fixed in this audit)

| Area | Gap | Fix | Odoo reference |
|---|---|---|---|
| Salesperson dashboard | `src/hooks/useSalespersonDashboard.ts` had three list queries (invoices, pos_transactions, payments) that scoped by org+business but **did not call `applyBranchFilter`** and did **not include `branchId` in the React Query key**. Selecting a branch did not narrow the dashboard, so a Branch-A salesperson appeared to have made sales in Branch B. Also, the POS query dereferenced `currentBusiness.id` without a guard. | Added `useBranch`, applied `applyBranchFilter` on all three queries, added `branchId` to all three query keys, and added `currentBusiness?.id` guards on `enabled` + early-returns. Also propagated `salespersonId` filter to the payments query (was only applied to invoices/POS). | Odoo's salesperson reports filter by the active operating-unit/branch when one is selected |

## ❌ Broken

None found in the Sales module after the salesperson-dashboard fix.

## ☢️ Dangerous

None found. The atomic-RPC pattern + the existing arch-guard tests
(`business-scoped-queries.test.ts`, `branch-id-stamping.test.ts`,
`je-branch-id-stamping.test.ts`) already prevent the historically dangerous
patterns (org-only filtering, missing branch stamping, drifting JE branch).

## 🕳️ Missing (intentional, deferred — see sales-audit.md §"Remaining Odoo gaps")

- Pricelist engine (per-currency, per-customer-tier unit prices).
- Multi-step delivery (pick → pack → ship). Currently single-step.
- "Lock confirmed sales orders" preference. Intentional SMB workflow choice.

## Architecture guard coverage

The plan called for a Sales-specific contamination guard mirroring a
hypothetical `posScopeContaminationGuard.test.ts`. That POS test does not
exist in this codebase — what does exist is a workspace-wide guard suite
that already covers Sales:

- `src/test/architecture/business-scoped-queries.test.ts` — fails the build
  if any `.from(<business-scoped-table>)` chain in `src/hooks`,
  `src/components`, `src/pages`, `src/lib`, or `src/services` lacks both
  `organization_id` and `business_id` filters. This already covers every
  Sales hook.
- `src/test/architecture/branch-id-stamping.test.ts` — fails the build if
  any `.from("invoices" | "sales_orders" | "estimates" | …).insert(…)`
  payload omits a literal `branch_id:` key. This already covers every
  Sales insert path.
- `src/test/architecture/je-branch-id-stamping.test.ts` — fails the build
  if a journal-entry insert in a Sales path does not stamp `branch_id`.
- `src/test/architecture/no-org-identity-reads.test.ts` — fails the build
  if a Sales hook reads identity columns without scope.

A Sales-specific guard would duplicate these without adding new coverage,
so we explicitly do **not** add `salesScopeContaminationGuard.test.ts`.
The hook-level fix above is the only outstanding action.

## Exit-criteria recap

- ✅ Verdict document committed (this file).
- ✅ Every GAP found in Phase C is patched (only one: salesperson dashboard).
- ✅ Sales arch-guard coverage verified — existing workspace-wide guards
  already cover Sales hooks; no new test required.
- ✅ No Sales query reachable without `(organization_id, business_id)` and,
  where a branch is active, `branch_id` partitioning.
- ✅ Invoice / payment / credit-note flows produce balanced, scoped JEs via
  atomic RPCs — verifiable in DB by joining `journal_entries.source_id` to
  the originating invoice/payment/credit-note row and asserting equal
  `business_id` and `branch_id` on both sides.
