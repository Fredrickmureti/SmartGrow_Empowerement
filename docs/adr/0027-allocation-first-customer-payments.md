# ADR 0027 — Allocation-first customer payment model

## Status
Accepted — 2026-06-02

## Context
Customer payments historically had two competing representations:

1. A single optional FK `payments.invoice_id` (one payment → at most one
   invoice).
2. A child table `payment_allocations` written only by the multi-invoice
   path (`record_multi_invoice_payment`).

The two were inconsistent. Single-invoice payments populated
`invoice_id` and skipped the allocation table; multi-invoice payments
populated allocations and left `invoice_id` NULL. Read sites — the
detail dialog, list table, statements, aging, receipts — read only
`invoice_id`, so multi-invoice payments rendered as **Unlinked** even
though the data existed elsewhere. Customer balance, statements, and
aging derived truth from three independent SUMs (`invoices.amount_paid`,
`payments.outstanding_amount`, `credit_notes.amount_applied`) with no
canonical chronological ledger.

The audit (`.lovable/plan.md`, 2026-06-02) traced the lifecycle, ranked
defects, and benchmarked against QuickBooks / Xero / NetSuite / SAP B1
/ D365 BC / Odoo / ERPNext. Every mature ERP treats payment allocation
as a child table with the payment header carrying only the cash side.

## Decision
Adopt an allocation-first model across the entire receivables stack.

### Canonical write contract
- `record_payment_atomic`, `record_multi_invoice_payment`, and
  `record_advance_payment` MUST insert a `payment_allocations` row for
  every applied amount. The single-invoice path now does this. The
  unapplied (deposit) portion stays on `payments.outstanding_amount`
  with no allocation row.
- `payments.invoice_id` is **deprecated**. Existing values are
  preserved for backward compatibility; new readers MUST NOT consume
  it. Scheduled for DROP one release after the architecture test
  banning UI reads has been green for a full cycle.

### Canonical read contract
- `usePaymentAllocations(paymentId)` is the only allowed read path
  for "what invoices did this payment settle?".
- `useCustomerLedger({contactId, …})` and the underlying
  `customer_ledger_entries` view are the only allowed read path for
  customer balance, statement, and aging. The view unions invoices
  (debit), allocations (credit), unapplied deposits (credit),
  credit notes (credit), and refunds (debit). Running balance is
  computed in the read layer so callers retain branch / date filter
  freedom.

### Provenance and audit
- `payment_allocations.source ∈ {rpc, backfill, reallocation}` and
  `payment_allocations.created_by` capture origin and actor.
- Historical payments with a legacy `invoice_id` link but no
  allocation row were backfilled with `source='backfill'` in the M-1
  migration.

### Invariants enforced by DB
1. `SUM(payment_allocations.amount WHERE payment_id = X) =
   payments.applied_amount` within 0.005 tolerance — deferred
   constraint trigger `trg_payment_alloc_sum_invariant`.
2. Every allocation must share `contact_id` and `business_id` with
   its parent payment — `trg_payment_alloc_consistency`.
3. No payment may be inserted into a closed fiscal period —
   `trg_payment_period_open` (BEFORE INSERT on `payments`,
   delegating to `is_period_open`).
4. Allocation `branch_id` is inherited from the parent payment
   header. The legacy `trg_cascade_branch_payment_allocations`
   trigger that overwrote it from the invoice has been dropped.
5. Reallocation is append-only: new allocation rows (positive for the
   new state, negative compensating rows for the prior state) — never
   UPDATE. Shipped as `reallocate_payment_atomic`.
6. Money-in is idempotent on a caller-supplied request key:
   `payments.client_request_id` under the partial unique index
   `payments_org_client_request_id_uq (organization_id,
   client_request_id)`. `record_multi_invoice_payment`,
   `record_payment_atomic` and `record_advance_payment` all replay the
   existing payment instead of posting a second one. The key MUST be
   derived from the payment intent — `crypto.randomUUID()` defeats it.


### Reversal semantics
Voided / unreconciled payments are excluded from the sum invariant —
reversal truth lives in `payment_reversal_events` per ADR 0012, not
in the `payments` row. Refunds appear in the ledger as a debit
against the customer.

## Batch 2 status
Shipped:
- `reallocate_payment_atomic` RPC.
- POS payment RPC alignment — `usePOSInvoiceRequest` posts through
  `record_payment_atomic` with the deterministic key `pos:<txn>:<tender>`.
- Single money-in surface: `RecordCustomerPaymentDialog` replaced the two
  competing `RecordPaymentDialog` components (invoices + sales), which are
  deleted. The ratchet in
  `src/test/architecture/payment-reversal-intent-contract.test.ts` pins the
  count at exactly one.

Still out of scope:
- `/sales/customers/:id/ledger` page rendering the ledger view with
  CSV/PDF export. Statement page should consume the same hook.
- Multi-currency FX guard between deposit account and invoice
  currency (deferred to ADR 0015).


## Invariants enforced by tests
1. `src/test/architecture/payment-allocations-first-class.test.ts`
   bans UI reads of `payments.invoice_id` and requires
   `PaymentDetailDialog` to consume `usePaymentAllocations`.
2. pgTAP coverage for the three new triggers
   (`trg_payment_alloc_sum_invariant`,
   `trg_payment_alloc_consistency`, `trg_payment_period_open`).

## References
- Audit plan: `.lovable/plan.md` (2026-06-02 re-audit)
- ADR 0012: Payment reversal intent model.
- Migration: `..._allocation_first_customer_payments.sql`
- Hooks: `src/hooks/usePaymentAllocations.ts`,
  `src/hooks/useCustomerLedger.ts`
