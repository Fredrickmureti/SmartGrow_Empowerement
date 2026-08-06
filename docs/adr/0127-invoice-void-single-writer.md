# ADR 0127 — Invoice void is a single server-side operation

Status: accepted
Date: 2026-08-06
Related: ADR 0123 (posting monopoly), ADR 0125 (AR payment reversal), ADR 0126 (AP reversal parity), ADR 0027 (allocation ledger)

## Context

Voiding a customer invoice was a client-side saga in
`src/hooks/useTransactionReversal.ts`: reverse the main journal entry, look up
and reverse the COGS sub-entry, run a defensive reversal-integrity check from
the browser, flip `invoices.status` and stamp the void columns, loop over live
payments reversing each journal entry and writing `payments.status = 'voided'`
by hand, then call `restore_invoice_stock_atomic`.

Each step is its own transaction over the network. A failure anywhere in the
middle leaves a documented state that no report can explain: revenue reversed
but the invoice still open, or the invoice voided with payments still counted
as cash, or both correct while the shipped stock is never returned. The payment
leg also duplicated `void_payment_atomic` (ADR 0125) — a second AR reversal
implementation, in the browser, with no reason-coded event and no fiscal-period
guard.

## Decision

`public.void_invoice_atomic(_invoice_id, _reason, _void_date, _actor,
_cascade_payments, _client_request_id)` owns the whole reversal in one
transaction:

1. Locks the invoice, returns `already_voided` on repeat (idempotent).
2. Refuses any void date inside a closed fiscal period.
3. Reverses every live journal entry sourced from the invoice — main and COGS —
   through `void_journal_entry_atomic`, never raw journal writes.
4. Stamps the void columns and repoints `reversal_journal_entry_id`.
5. Cascades to live payments discovered through `payment_allocations` (ADR
   0027), delegating each to `void_payment_atomic` with reason code
   `invoice_voided_cascade`. Without `_cascade_payments` it refuses rather than
   silently orphaning cash.
6. Restores stock via `restore_invoice_stock_atomic`.

The header flip happens before the cascade so `void_payment_atomic` recomputes
`amount_paid` against a voided invoice and does not reopen its status.

Credit-note issuance stays outside the transaction, in the hook: a credit note
is its own accounting document with its own number series and posting, not part
of the reversal.

## Consequences

- Reversal is all-or-nothing; the partial states above are unreachable.
- One AR reversal implementation, server-side, with reason codes and period
  guards on every path including the cascade.
- Two new ratchets in `src/test/architecture/journal-posting-monopoly.test.ts`
  ban client writes to the invoice void columns and any client call to
  `restore_invoice_stock_atomic`.
- Bug found and fixed while consolidating: `void_payment_atomic` defaulted its
  reason code to `payment_voided`, which is not a member of
  `payment_reversal_reason` — a void with no explicit code failed on the enum
  cast. The column is nullable; the fallback is gone.
