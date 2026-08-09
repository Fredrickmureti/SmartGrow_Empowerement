# Payments & Reconciliation — Audit Findings and Convergence Plan

## What the investigation actually found

This subsystem is **already enterprise-grade in most respects**. Both the AR and AP
allocation-first migrations (ADR 0027 / 0028) are *complete in the database*, not
pending as the docs claim: I confirmed directly against the live schema that
`payments.invoice_id` and `bill_payments.bill_id` no longer exist. Every distinct
business event is modelled as its own server-side primitive, and no application code
writes money into tables directly.

### Verified as correct — do not disturb

- **Separate business events, separate primitives.** `unapply_payment_atomic`,
  `unreconcile_payment_atomic`, `reallocate_payment_atomic`, `void_payment_atomic`,
  `refund_customer_atomic`, `issue_credit_note_for_payment_atomic`,
  `apply_customer_deposit_atomic`, plus AP mirrors (`void_bill_payment_atomic`,
  `refund_from_vendor_atomic`, `apply_vendor_credit_*`). Unreconcile, void, refund and
  credit note are genuinely distinct — not collapsed into CRUD.
- **Allocation-first, append-only.** Reversals append compensating negative allocation
  rows and recompute invoice/bill balances from the *live allocation sum*; they never
  delete history or decrement a client-supplied delta.
- **RPC monopoly.** No client `.insert`/`.update` into `payments`, `payment_allocations`,
  `bill_payments`, `bill_payment_allocations`. POS keeps its own tender tables and
  bridges into AR only through `record_payment_atomic`. Bank reconciliation writes only
  through `reconcile_bank_transaction_atomic`.
- **Database invariants.** Allocation sum invariants (deferrable), contact/business
  consistency, closed-period rejection, self-approval segregation-of-duties guards, and
  a unique index preventing two live journal entries per source document.
- **Idempotency where it already exists.** Refunds, reversals, deposit application and
  payment-sourced credit notes all carry `client_request_id` with unique indexes.
- **One reporting spine.** `customer_ledger_entries` / `vendor_ledger_entries`,
  `finance_ar_open_items` / `finance_ap_open_items`, and the tie-out views.

None of the above will be rewritten.

### Verified defects (each backed by code or database evidence)

**D1 — Money-in is not idempotent (highest severity).**
`payments` and `bill_payments` have no `client_request_id` column and no idempotency
index, and `record_multi_invoice_payment` / `record_multi_bill_payment` /
`record_payment_atomic` accept no request key. Every *reversal* path is protected; the
path that creates money is not. A double-submit, retry-after-timeout, or replayed POS
tender produces two payments and two journal entries — the journal source-uniqueness
index cannot help, because the duplicate carries a new payment id.

**D2 — M-Pesa inbound can silently strand cash.**
In `supabase/functions/mpesa-c2b/index.ts:342-381`, settlement runs only inside the
`else` branch of the transaction-insert dedupe gate, and a settlement failure is merely
logged. If the settlement RPC fails, the feed row is stored as matched, and any webhook
redelivery is swallowed by the duplicate gate — the money exists in the feed and never
becomes a payment, with no alert.

**D3 — Unreconcile reverses the payment itself.**
`unreconcile_payment_atomic` voids the payment's journal entry and nulls
`journal_entry_id`, which reverses the whole `Dr Bank / Cr AR` entry. The payment stays
valid, but the cash disappears from the general ledger until someone reapplies it —
bank balance understated, and permanently wrong if never reapplied. The correct shape
already exists next door: `unapply_payment_atomic` reclassifies `Dr AR / Cr Customer
Deposits` and leaves cash untouched. Currently latent (the operation is not exposed in
the UI), which makes it cheap to fix now.

**D4 — AP has no advance/unapplied vendor payment.**
`bill_payments` has no vendor column at all; vendor identity is only reachable through
allocations to bills. A vendor payment on account therefore cannot exist, and AR's
customer-deposit capability has no AP mirror.

**D5 — Bank reconciliation creates payments without a period guard or request key.**
`reconcile_bank_transaction_atomic` creates payment/bill-payment rows; closed-period
protection is only inherited from row triggers, and repeated matching has no idempotency
key of its own.

**D6 — Documentation and guard drift.**
ADR 0028 still labels the completed S3c work "deferred"; project memory lists finished
items as pending; two parallel `RecordPaymentDialog` components remain (ratcheted at
"max 2"); migration rollback deletes `payments` rows directly with no guard test
covering that carve-out.

## Convergence plan

Ordered by financial risk. Each step is additive and preserves existing call signatures.

**1. Idempotent money-in.** Add `client_request_id` to `payments` and `bill_payments`
with a partial unique index. Extend `record_multi_invoice_payment`,
`record_multi_bill_payment` and the `record_payment_atomic` shim with an optional
`_client_request_id`; when it matches an existing payment, return that payment instead of
creating a second one. Thread a deterministic key from the record-payment dialogs,
`useBills`, the POS invoice bridge and the M-Pesa function.

**2. M-Pesa settlement becomes retryable.** Move settlement outside the dedupe gate and
drive it from the feed row's own settlement state, so a redelivery retries an unsettled
transaction rather than skipping it; surface failures instead of swallowing them.

**3. Correct unreconcile accounting.** Replace the journal void inside
`unreconcile_payment_atomic` with the reclassification `Dr AR / Cr Customer Deposits`,
matching `unapply_payment_atomic`; reapply then consumes the deposit. Cash never leaves
the ledger during an unreconciliation.

**4. Bank reconciliation hardening.** Add an explicit period check and an idempotency key
to `reconcile_bank_transaction_atomic`.

**5. Vendor payments on account.** Add `vendor_id` to `bill_payments`, allow
`record_multi_bill_payment` to run with zero allocations against a Vendor Deposits
account, and mirror the deposit-application flow used on the customer side.

**6. Close the drift.** Update ADR 0027/0028 and the memory files to match reality; add a
guard test banning direct writes to the payment tables including migration code (with the
rollback path explicitly allowlisted and justified); consolidate the two
`RecordPaymentDialog` components to one and tighten the ratchet to 1.

**7. Publish the audit.** Write the full A–P deliverable (domain model, lifecycle,
allocation model, accounting flow, downstream consumer map, enterprise comparison,
preserved architecture) to `docs/audit/payments-reconciliation-2026-08.md`, and record the
two behavioural changes as ADRs.

### Risk and verification

Steps 1, 4 and 5 are additive schema changes with defaulted parameters, so existing
callers keep working. Step 3 changes accounting behaviour for an operation with no
current UI caller and no production rows on this instance, so regression exposure is
minimal. Verification uses the existing pattern: SQL behavioural tests under
`supabase/tests/` (duplicate-key replay proves one payment and one journal entry;
unreconcile proves bank balance unchanged and AR restored) plus the architecture ratchets
under `src/test/architecture/`.
