# Settlement Convergence — Verification Verdict and Next Phases (C4–C6)

## Phase 1 — Independent verification (done this turn, against the live DB and code)

Confirmed **true** in the previous engineer's status file:

- **Posting monopoly holds.** A scan of every `public` function for raw
  `INSERT INTO journal_entries|journal_entry_lines` returns exactly three:
  `post_journal_entry_atomic`, `update_journal_entry_atomic`,
  `void_journal_entry_atomic`. No other database path mints ledger rows.
- **Duplicate settlement overloads are gone.** `employee_loan_apply_repayment`,
  `record_payment_atomic`, `record_multi_invoice_payment` and
  `record_multi_bill_payment` each exist exactly once. `record_bill_payment_atomic`
  does not exist.
- **Phase C3 (AR payment reversal) is real.** `void_payment_atomic` exists with
  both a fiscal-period guard and an `already_voided` idempotency branch;
  `unreconcile_payment_atomic`, `unapply_payment_atomic` and
  `reallocate_payment_atomic` all carry period guards.
- **Client no longer writes AR invoice balances on reversal.**
  `decrementInvoicePaid` is deleted from `src/hooks/useTransactionReversal.ts`.
- **POS and advances** post through the engine (`post_pos_statement_gl`,
  `disburse_employee_advance`).

Confirmed **incomplete / newly found**:

1. **AP reversal is still the exact anti-pattern ADR 0125 banned on AR.**
   `voidBillPayment` (`src/hooks/useTransactionReversal.ts`) runs a multi-step
   browser sequence: reverse the JE, then loop bills writing
   `bills.amount_paid` by client-side decrement, then **DELETE the
   `bill_payments` row**, cascading `bill_payment_allocations` away. This
   destroys settlement history (violates the append-only allocation invariant),
   and a mid-sequence failure leaves the GL reversed while the bill still shows
   paid. AP has no parity with AR. This is the highest-risk remaining item.
2. **`voidInvoice` is still a client-orchestrated saga** (JE reversal, status
   flip, payment cascade, optional credit note, stock restore) across separate
   round-trips.
3. **No behavioural tests** for the new reversal RPCs — `supabase/tests/`
   contains no payment-reversal file; only architecture ratchets guard them.
4. `unapply_payment_atomic` / `unreconcile_payment_atomic` have period guards
   but no explicit already-applied short-circuit like `void_payment_atomic`'s.

## Phase 2 — Plan

### C4 — AP reversal single writer (parity with ADR 0125)
New `public.void_bill_payment_atomic(_bill_payment_id, _reason, _void_date, _actor, _client_request_id)`
doing everything in one transaction: reverse the linked JE (falling back to a
`source_type='bill_payment'` lookup), set the payment header to `voided`
(**never delete it**), recompute every touched bill's `amount_paid` and status
**from the live allocation sum**, and append an audit event. Period-guarded and
idempotent (`already_voided`). `voidBillPayment` becomes a thin call.
Extend the ratchet to ban client writes to `bills.amount_paid` and deletes
against `bill_payments` / `bill_payment_allocations`.

### C5 — Invoice void as a server-side operation
`public.void_invoice_atomic(...)`: reverse main + COGS journals, set invoice
status, cascade payment voids through `void_payment_atomic`, optionally issue
the credit note via `issue_credit_note_for_payment_atomic`, and restore stock —
one transaction, idempotent, period-guarded. `voidInvoice` keeps only reason
collection and error surfacing. Ratchet: no client-side invoice status flip
paired with a JE reversal.

### C6 — Behavioural coverage
pgTAP under `supabase/tests/payment_reversal_test.sql` and
`bill_payment_reversal_test.sql`: multi-allocation void restores each document
from the allocation sum; double void returns `already_voided` with no second
JE; void in a closed period raises; unreconcile appends compensating rows
rather than deleting; bill payment row survives a void.
Add the same short-circuit to `unapply_payment_atomic` /
`unreconcile_payment_atomic` while covering them.

### Deferred (needs a business decision, not code)
Historical backfill: advances disbursed before Phase C have no journal, and
pre-C2 recoveries sit against `advance_recovery_payable` instead of the
receivable. Funding account and posting period must be chosen deliberately —
I will raise this rather than bulk-post.

## Technical notes
- Verification method: `pg_proc` source scans for raw journal inserts, overload
  counts, period-guard and idempotency markers; ripgrep over
  `src/hooks/useTransactionReversal.ts` and `supabase/tests/`.
- Each phase ends with `tsgo --noEmit`, the architecture ratchets in
  `src/test/architecture/journal-posting-monopoly.test.ts`, and an ADR
  (`0126-ap-reversal-single-writer.md`, `0127-invoice-void-single-writer.md`).
- No source files were modified during verification.
