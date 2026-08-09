---
name: Allocation-first vendor payments
description: ADR 0028 — bill_payment_allocations is canonical AP link; useVendorLedger over vendor_ledger_entries view is the SoT for vendor balance
type: feature
---

## Rule
Vendor payments are **allocation-first** (ADR 0028, AP mirror of
ADR 0027). The sanctioned reads are:

- `useVendorLedger({contactId, businessId, branchId, dateFrom,
  dateTo})` over `vendor_ledger_entries` for vendor balance,
  statements, and aging — never sum bills/bill_payments by hand.
- For "what bills did this payment settle?" select
  `bill_payment_allocations(amount, bill:bills(...))` — never
  `bill_payments.bill_id` from a fetched row in new UI code.

## DB invariants
- `trg_bill_payment_alloc_sum_invariant` (DEFERRABLE) — Σ allocations
  ≤ `bill_payments.amount` (+0.005).
- `trg_bill_payment_alloc_consistency` — every allocation's bill
  shares vendor + business + organization with parent.
- `trg_bill_payment_period_open` (BEFORE INSERT on `bill_payments`)
  — rejects payments dated in a closed fiscal period.
- `auto_create_bill_payment_allocation` (AFTER INSERT on
  `bill_payments`) — auto-stamps a `legacy_fk` allocation row when
  the legacy single-bill `bill_id` is set, so the allocation
  surface is always populated.

## Architecture guard
`src/test/architecture/bill-payment-allocations-first-class.test.ts`
pins the ledger-view source for vendor statements, asserts
`deriveBillFromAllocations` exists with the canonical 0/1/N display
contract, and ratchets the `bill_payments.bill_id` reader allowlist.
Adding a new entry requires reviewer sign-off; the goal is zero.

## Shipped (S3b — 2026-06-02)
- `useVendorStatements.generateStatementData` reads
  `vendor_ledger_entries` (period + prior-period for opening
  balance). View convention (credit = AP↑) is mapped to statement
  convention (debit = AP↑) at the boundary.
- `src/lib/payments/deriveBillFromAllocations.ts` — structural twin
  of `deriveInvoiceFromAllocations`. Same display contract.
- Architecture guard above.

## Supplier advances (D6.1 — shipped)
Money paid to a supplier before a bill exists is an **advance**, not a
bill settlement:

- Record: `useBills().recordVendorAdvance` →
  `record_vendor_advance_payment` (Dr Vendor Credits / Cr Bank).
  UI: `RecordVendorAdvanceDialog`.
- Apply: `useBills().applyVendorAdvance` →
  `apply_vendor_advance_atomic` (Dr Accounts Payable / Cr Vendor
  Credits). UI: `ApplyVendorAdvanceDialog`.
  **Never** apply an advance through `record_multi_bill_payment` — that
  engine credits Bank and would count the same cash out twice.
- Read unapplied AP cash **only** from the `vendor_unapplied_advances`
  view via `useVendorUnappliedAdvances`. `bill_payments` has no
  `outstanding_amount` column; never re-derive it by summing
  `bill_payment_allocations` in component code.
- Operator surface: `/finance/vendor-credits` (`VendorCredits` page),
  the AP mirror of `/finance/customer-credits`.
- Both RPCs are idempotent on `client_request_id`; callers must pass a
  stable key per attempt.

## Pending (S3c)
- Move writers (`useBills.recordBillPayment`,
  `useTransactionReversal`, `useVendorCreditNotes`,
  `applyVendorCredit`) to `record_multi_bill_payment`.
- Drive the ratchet allowlist to zero, then
  `ALTER TABLE bill_payments DROP COLUMN bill_id` together with
  `trg_auto_bill_payment_allocation` and
  `trg_cascade_branch_bill_payments`.
