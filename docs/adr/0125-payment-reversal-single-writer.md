# ADR 0125 — Payment reversal is a server-side settlement operation

Status: accepted
Date: 2026-08-06
Related: ADR 0012 (reason-coded reversal events), ADR 0027 (allocation ledger, invariant 5)

## Context

Voiding and un-reconciling a customer payment were both implemented as
sequences of client round-trips in `src/hooks/useTransactionReversal.ts`:

1. reverse the journal entry via `void_journal_entry_atomic`,
2. flip `payments.status`,
3. loop over allocations and write `invoices.amount_paid` from the browser,
4. best-effort call to `record_payment_reversal_event`.

Two defects follow from that shape.

**Partial failure.** The steps are separate transactions. A dropped connection
after step 1 leaves the general ledger reversed while the invoice still counts
the cash — the balance sheet and the AR sub-ledger disagree, and nothing in the
audit trail explains why. Step 4 being non-fatal means a reversal could also
complete with no reason-coded event at all.

**Destroyed history.** The un-reconcile path went further and `DELETE`d rows
from `payment_allocations`. ADR 0027 invariant 5 makes the allocation table
append-only precisely so that "what settled what, and when" is reconstructable.
Deleting the rows makes the reversal invisible.

## Decision

Both operations become single canonical RPCs, in the same shape as the rest of
the settlement engine:

- `public.void_payment_atomic(_payment_id, _reason, _reason_code, _void_date, _actor, _client_request_id)`
- `public.unreconcile_payment_atomic(_payment_id, _reason, _actor)`

Each one, in one transaction: reverses the linked journal entry (falling back to
a lookup by `source_type = 'payment'` when the FK is unset), updates the payment
header, recomputes every touched invoice's `amount_paid` and status **from the
live allocation sum** rather than by decrementing a client-supplied delta, and
inserts the `payment_reversal_events` row. Both refuse to act in a closed
fiscal period and both are idempotent — a repeated void returns
`already_voided` instead of double-reversing.

Void leaves allocation rows in place: `status = 'voided'` already excludes the
payment from every live-allocation sum, so the rows survive as history.
Un-reconcile appends compensating negative rows for the same reason.

The hook keeps only what a client should own: reading labels for the audit log,
surfacing errors, and the ADR 0012 guard that refuses a reversal with no
`reasonCode`.

## Consequences

- Recomputing from the allocation sum makes the invoice balance self-healing:
  a drifted `amount_paid` is corrected the next time any reversal touches it.
- Three ratchets in `src/test/architecture/journal-posting-monopoly.test.ts`
  freeze the old shapes out: no client writes to `invoices.amount_paid`, no
  deletes against either allocation table, and the existing journal-insert ban.
- The helper `decrementInvoicePaid` is deleted. Reintroducing it, or any
  client-side invoice balance write on a reversal path, fails the ratchet.
