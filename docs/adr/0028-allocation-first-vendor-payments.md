# ADR 0028 — Allocation-first vendor payments

## Status
Accepted — 2026-06-02

## Context
AR went allocation-first under ADR 0027. AP still linked a vendor
payment to a single bill via `bill_payments.bill_id`, so multi-bill
vendor payments lose linkage exactly the way customer payments did
pre-0027. Symmetric problem, symmetric fix.

## Decision
`bill_payment_allocations` is the canonical link from a vendor
payment to one or more bills. `bill_payments.bill_id` is retained
temporarily for backward compatibility; an `AFTER INSERT` trigger
on `bill_payments` auto-creates a `legacy_fk` allocation row when
the FK is set, so the allocation surface is always populated.

DB invariants:
- `trg_bill_payment_alloc_consistency` — each allocation's bill
  shares vendor + business + organization with the parent payment.
- `trg_bill_payment_alloc_sum_invariant` (DEFERRABLE) —
  Σ allocations ≤ `bill_payments.amount` (+0.005).
- `trg_bill_payment_period_open` — vendor payments dated in a
  closed fiscal period are rejected.
- `auto_create_bill_payment_allocation` — backfills allocations
  for legacy single-FK inserts.

New RPC: `record_multi_bill_payment(_org, _business, _vendor,
_allocations[], _total, _date, _method, _ref, _notes, _by,
_bank_account, _payable_account, _branch)` — writes one
`bill_payments` header (bill_id NULL), N allocation rows, and one
JE: Dr AP (Σ allocated) / Cr Bank (total).

New view: `vendor_ledger_entries` (security_invoker) — chronological
vendor ledger over bills + bill_payment_allocations + vendor credit
notes. Single source of truth for vendor statements and AP balance.

## Migration plan
- S3 (this loop): table, triggers, backfill, RPC, view, hook.
- S3b (this loop, 2026-06-02): reader-side parity for vendor
  statements — `useVendorStatements.generateStatementData` rewritten
  onto `vendor_ledger_entries`; `deriveBillFromAllocations` helper
  shipped; architecture guard
  `src/test/architecture/bill-payment-allocations-first-class.test.ts`
  added with a ratcheted allowlist of remaining legacy readers.
- S3c (shipped): writer-side callers rewritten onto
  `record_multi_bill_payment`, the ratchet allowlist driven to zero, and
  `bill_payments.bill_id` dropped together with its cascade trigger and
  auto-allocation trigger. `bill_payments` is now allocation-only, exactly
  as `payments` is after `payments.invoice_id` was retired.
- S3d (shipped): AP money-out is idempotent on
  `bill_payments.client_request_id` under the partial unique index
  `bill_payments_org_client_request_id_uq (organization_id,
  client_request_id)`. `record_multi_bill_payment`,
  `record_vendor_advance_payment` and `apply_vendor_advance_atomic` replay
  instead of double-paying. Keys MUST be derived from the payment intent.
- Reversal is server-side only: see ADR 0126 —
  `void_bill_payment_atomic` is the single writer, and client writes to
  `bills.amount_paid` or deletes against `bill_payments` are banned by
  `src/test/architecture/journal-posting-monopoly.test.ts`.


## Consequences
- Vendor receipts/statements can faithfully render multi-bill
  payments (sum, per-bill breakdown, unapplied excess).
- AP aging via `finance_ap_open_items` (JE-sourced) is unchanged.
- Existing single-bill flows (`record_bill_payment_atomic`, the
  `RecordBillPaymentDialog`) continue to work; the auto-trigger
  keeps them allocation-correct.
