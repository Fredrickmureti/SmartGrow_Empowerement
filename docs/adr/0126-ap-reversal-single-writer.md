# ADR 0126 — Supplier payment reversal is a server-side settlement operation

Status: accepted
Date: 2026-08-06
Related: ADR 0027 (append-only allocation ledger), ADR 0028 (allocation-first vendor payments), ADR 0125 (AR equivalent)

## Context

ADR 0125 moved customer payment reversal into a single transactional RPC. The
accounts-payable side kept the shape ADR 0125 banned: `voidBillPayment` in
`src/hooks/useTransactionReversal.ts` reversed the journal entry, then looped
the allocations writing `bills.amount_paid` by client-side decrement, then
**deleted** the `bill_payments` row — cascading `bill_payment_allocations` with
it.

Two defects follow, identical in class to the AR ones:

- **Partial failure.** A dropped connection after the journal reversal leaves
  the ledger reversed while the bill still counts the cash.
- **Destroyed history.** Deleting the payment and its allocations makes the
  settlement — and the reversal — unreconstructable, violating ADR 0027
  invariant 5. It also orphaned the withholding-tax journal, which the client
  path never reversed at all.

## Decision

`public.void_bill_payment_atomic(_bill_payment_id, _reason, _void_date, _actor, _client_request_id)`
performs the whole operation in one transaction:

1. Reverses **every** live journal entry sourced from the payment — the
   settlement entry and any withholding-tax entry — through
   `void_journal_entry_atomic`.
2. Marks the header `status = 'voided'` with `voided_at` / `voided_by` /
   `void_reason`. The row is never deleted.
3. Recomputes each touched bill's `amount_paid` **from the live allocation
   sum** (allocations of non-voided payments) and derives
   `paid` / `partial` / `received` from it, leaving `void` and `draft` bills'
   status untouched.
4. Appends a `bill_payment_reversal_events` row.

It refuses to act in a closed fiscal period and is idempotent — a repeated void
returns `already_voided` instead of double-reversing.

`bill_payments` gains `status`, `voided_at`, `voided_by`, `void_reason` and
`updated_at`. Existing rows default to `completed`.

## Consequences

- Recomputing from the allocation sum makes bill balances self-healing, and
  correctly unwinds the WHT top-up because the WHT journal is reversed too.
- Voided supplier payments remain visible and auditable rather than vanishing.
- Two new ratchets in
  `src/test/architecture/journal-posting-monopoly.test.ts` ban client writes to
  `bills.amount_paid` and deletes against `bill_payments`.
- Readers that list supplier payments should exclude `status = 'voided'` when
  they mean "live cash out".
