# 2026-06-02 — AR / AP / Collections final mile

## S1 — Verified shipped
- `payments.invoice_id` dropped; 5 UI readers repointed via
  `deriveInvoiceFromAllocations`.
- `finance_ar_open_items` rewritten on `payment_allocations`
  (fixed multi-invoice overcounting).
- Architecture guard `payment-allocations-first-class.test.ts` 8/8.

## S2 — Re-audited and verified shipped (plan was stale)
`generate-document` `customer_payment` template loads
`payment_allocations`, emits one line per invoice plus an
"Unapplied advance" line, items-as-truth totals reconciliation
(`supabase/functions/generate-document/index.ts:497-658`).

## S3 — Shipped this loop (ADR 0028)
- `bill_payment_allocations` table + RLS/GRANTs/indexes.
- Triggers: consistency, deferred sum-invariant
  (Σ ≤ `bill_payments.amount`), period-open guard, auto-allocate
  on legacy FK insert.
- Backfill of existing `bill_payments`.
- RPC `record_multi_bill_payment` (one header, N allocations,
  one JE Dr AP / Cr Bank).
- View `vendor_ledger_entries` (security_invoker).
- Hook `useVendorLedger`.
- ADR 0028, memory `vendor-payment-allocations`.

## S4 — Shipped this loop
- `/sales/collections` workspace on top of `useAgingReport` +
  `useCustomerLedger` + existing `RecordPaymentDialog`.
- KPI strip + bucket/search filters + row expansion with invoice
  detail + per-row actions (record payment, open ledger, send
  statement).

## Deferred / S3b
- Repoint `useVendorStatements`, `useBills`, `BillDetailDialog`,
  `VendorPayments` onto allocations.
- `deriveBillFromAllocations` helper.
- Architecture guard test
  `bill-payment-allocations-first-class.test.ts`.
- `ALTER TABLE bill_payments DROP COLUMN bill_id`.

## Re-audit notes
- Previous agent's "S2 deferred" claim was incorrect — the
  template already supported multi-invoice receipts. Plan file
  has been refreshed to prevent re-work.
- The auto-allocation trigger means existing single-bill flows
  keep working without any code change — the allocation surface
  is always populated going forward, so the S3b reader repoint
  has no data risk.
