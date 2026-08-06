# ADR 0124 — Employee advances settle through the posting engine

Status: Accepted
Date: 2026-08-06

## Context

The settlement convergence audit (ADR 0123) left one module outside the
canonical boundary: **employee cash advances**. `employee_advances` had a
status machine (`requested → approved → disbursed → repaid/cancelled`) but no
accounting at all. Disbursement was a client-side `UPDATE ... SET status =
'disbursed'` issued from `useEmployeeAdvances`. Cash left the business and
nothing hit the ledger, so:

- the advance never appeared as a receivable asset,
- the bank/cash account was overstated by the outstanding advance balance,
- repayments recovered through payroll (`advance_repayment_schedule`) had no
  originating debit to relieve.

Separately, `employee_loan_apply_repayment` existed as two overloads (6-arg
and 8-arg), the pattern ADR 0123 bans: one concern, one implementation.

## Decision

1. **`public.disburse_employee_advance(advance_id, payment_account_id,
   disbursement_date)` is the only way to disburse an advance.** It performs
   the status transition and the GL posting in one transaction:

   ```
   Dr  Employee advance receivable   amount
       Cr  Bank / Cash                       amount
   ```

   Account resolution reuses `resolve_expense_default_account`, with priority
   `employee_advance_receivable → loan_receivable` for the debit and the
   caller-supplied funding account → `bank` → `cash` for the credit. A missing
   mapping raises rather than posting to a guessed account.

2. **Posting goes through `post_journal_entry_atomic`** with
   `source_type = 'employee_advance'`, `source_id = advance.id`. Balance,
   fiscal-period lock, posting-role validation and `accounting_events`
   emission are inherited, not reimplemented.

3. **Replay is idempotent.** An existing non-void journal for the same
   `(source_type, source_id)` short-circuits and relinks rather than posting a
   second entry. `employee_advances.journal_entry_id` carries the link back.

4. **The 6-arg `employee_loan_apply_repayment` overload is dropped.** Callers
   pass the two terminal-event arguments explicitly.

## Consequences

- Advance balances are now visible on the balance sheet and reconcilable
  against `advance_repayment_schedule`.
- `src/test/architecture/journal-posting-monopoly.test.ts` gained a ratchet
  banning client-side writes of `status = 'disbursed'`.
- Historical advances disbursed before this change carry no journal. They must
  be backfilled deliberately (replaying `disburse_employee_advance` per advance
  is safe and idempotent) — this migration does not post retroactively, because
  guessing the original funding account and period would be wrong.
- Advance **repayment** posting (relieving the receivable as payroll deducts)
  remains outstanding and is tracked as the next item.

## Addendum — the recovery leg (payroll)

Disbursement without recovery only fixed half the loop: the receivable was
booked but never relieved, and payroll credited a generic
`advance_recovery_payable`, double-counting the money as a liability. The
recovery leg now mirrors the loan pattern from ADR 0091:

1. **One writer.** `process_payroll_advance_recoveries(run, number, period,
   recoveries)` owns the `advance_repayment_schedule` rows and the
   `employee_advances.recovered_amount` / status transition. `compute-payroll`
   hands over the list and writes none of it itself. Replay is a no-op: a
   schedule row already existing for `(advance_id, payroll_run_id)` is skipped.

2. **One resolver.** `payroll_advance_recovery_gl_targets(run)` returns the
   per-advance receivable account — `employee_advance_receivable`, falling back
   to `loan_receivable`, exactly as disbursement resolves it — so the credit
   lands on the same account the debit did.

3. **`post-payroll-gl` diverts `advance_recovery` lines** away from the payable
   sweep and credits those targets instead, with any rounding residual applied
   to the first target so the journal balances against the payslip lines.

4. **`payroll_required_gl_mappings_for_run`** no longer demands
   `advance_recovery_payable`; it asks for the advance receivable instead, and
   treats an existing `loan_receivable` mapping as satisfying it.
