# ADR 0033: Single AR/AP Open-Items Engine

## Status
Accepted — 2026-06-02

## Context
ADRs 0029–0032 unified the customer ledger, vendor ledger, and partner-ledger
report as a strict projection of the General Ledger. One operational surface
remained: the **Aging Report** (`get_ar_ap_aging_from_ledger`) and the
sub-ledger total side of the **Control Account Reconciliation** card both
read `finance_ar_open_items` / `finance_ap_open_items`, which were defined
purely against `invoices` / `payment_allocations` and `bills` /
`bill_payment_allocations`. That created two failure modes:

1. **Phantom open documents.** An invoice or bill with no posted journal
   entry still appeared in aging, even though it carried zero weight in
   GL, trial balance, or partner ledger.
2. **Missing manual journals.** A manual journal posted to the AR/AP
   control account with a `contact_id` (now mandatory per ADR-0031)
   affected partner ledger and trial balance but never appeared in aging
   — so customer-facing and finance-facing reports could legitimately
   disagree.

## Decision
Rewrite the two views as GL-gated projections:

- **Invoice / bill branch.** Keep document-level granularity, but include
  only rows where a posted JE on the AR/AP control account exists for that
  document (`invoice_has_je` / `bill_has_je` CTEs). Allocations are still
  the source of `applied_amount` because GL alone cannot attribute a
  payment to a specific invoice.
- **Manual-journal branch.** Aggregate `ar_subledger_entries` /
  `ap_subledger_entries` rows whose `source_type` is not an invoice / bill
  / payment / credit-note variant, grouped by
  `(organization, business, branch, journal_entry_id, contact_id)`, and
  expose each group as a synthetic "journal" document with
  `document_total = residual_amount = Σ(debit − credit)` (or the AP-sign
  inverse). This is the missing surface that lets aging fully reconcile
  with partner ledger.

Column shape is preserved exactly, so `get_ar_ap_aging_from_ledger`,
`get_control_account_reconciliation`, the `useAgingReport` hook, the
`AgingReport.tsx` and `ControlAccountReconciliationCard.tsx` views, and
the generated `types.ts` all keep working unchanged.

## Consequences
- The Aging Report and the Control Account Reconciliation card now consume
  the same GL-anchored projection that powers Customer Ledger, Vendor
  Ledger, Partner Ledger, Trial Balance, and Balance Sheet. Documents
  without a posted JE no longer pollute aging totals; manual journals on
  AR/AP control surface as actionable line items.
- The drift sensor (`control_account_drift_log`, ADR-0032) should now
  produce zero rows in healthy state across all organisations. Any future
  non-zero drift identifies a real bookkeeping anomaly, not a structural
  mismatch between two engines.
- Credit balances (Σ on AR < 0 for a contact) are intentionally still
  filtered out of aging by the `residual_amount > 0.01` clause in
  `get_ar_ap_aging_from_ledger`. Those appear on the customer statement
  and partner ledger as credit balances — the aging report shows debt
  buckets, not asset positions.

## Closure
With this change, every financial summary report (trial balance, balance
sheet, P&L, cash flow, GL, journal, partner ledger, customer ledger,
vendor ledger, aging, control-account reconciliation, inventory ↔ GL)
reconciles to the same `journal_entry_lines` rows. There is one accounting
engine. The AR/AP single-engine programme started in ADR-0029 is complete.
