# ADR 0091 — Loans emit events, Finance owns posting and numbering

**Status:** Accepted (2026-07-25)
**Related:** ADR 0020 (JE narration), ADR 0028 (payment allocations)

## Context

`employee_loan_disburse` failed with
`23502 null value in column "entry_number" of relation "journal_entries"`.
The cause was not numbering: the loan module had re-implemented the GL
posting step with its own `INSERT INTO journal_entries` /
`journal_entry_lines`, omitting `entry_number` (which has no default and no
assigning trigger) and `organization_id` on lines. It therefore also lost
balance validation, header-total handling and source-key idempotency.

The rest of the platform (invoices, credit notes, customer payments,
refunds, POS statements/settlements, deliveries, stock adjustments) posts
through `post_journal_entry_atomic` and numbers through
`generate_next_je_number(org, business)`.

Alongside the drift, the loan GL lifecycle was incomplete: no bank-ledger
row on disbursement (so payouts were unreconcilable), and no posting at all
for manual repayments, repayment reversals or write-offs — even though
`loan_types.interest_income_account_id` / `writeoff_account_id` existed.

## Decision

1. **Finance owns posting.** No module may `INSERT INTO journal_entries`.
   Every GL event goes through `post_journal_entry_atomic`.
2. **Finance owns journal identity.** `entry_number` comes only from
   `generate_next_je_number`. No placeholders, no random numbers.
3. **Loans own state and events.** Guards (`_loan_assert_transition`, SoD,
   dual control), account resolution (`_loan_resolve_account` →
   `resolve_default_account`) and `loan_log_event` (audit row +
   `business_event_outbox`) stay in the loan module.
4. **One source_type per loan GL event**, giving per-event idempotency
   through the engine's source-key lookup:
   `loan_disbursement` (source = loan), `loan_repayment` (source =
   repayment), `loan_repayment_reversal` (source = reversal row),
   `loan_write_off` (source = loan).
5. **Cash events produce a bank movement.** `_loan_record_bank_movement`
   writes `bank_transactions` when the GL cash account maps to a
   `bank_accounts` row, keyed `loan-disb:<id>` / `loan-repay:<id>` so
   retries cannot duplicate it.
6. **Receivable carries principal only.** Repayments split pro-rata:
   principal to loan receivable, interest to interest income (falling back
   to full principal recovery when no income account is mapped).
   `finance_loan_receivable_integrity_check` compares on a principal basis.
7. **Posted entries are immutable.** Reversing a repayment posts a mirrored
   entry; it never updates the original.
8. **Payroll-deducted instalments settle the asset, not a liability.**
   `post-payroll-gl` no longer buckets `loan_repayment` payslip lines with
   statutory deductions (which credited `<rule_code>_payable`). It calls
   `payroll_loan_repayment_gl_targets(run)`, which aggregates that run's
   `loan_repayments` rows (excluding reversals) and splits them through
   `_loan_split_repayment`, so payroll credits loan receivable / interest
   income on exactly the basis the integrity check reconciles against.
   Consequently `payroll_required_gl_mappings_for_run` no longer demands a
   `_payable` mapping for loan rule codes.


## Consequences

- Fiscal-period locks, org write-locks, SoD guards and balance enforcement
  now apply to loan postings automatically, because there is one path.
- Enforced by `src/test/architecture/loan-posting-engine-ownership.test.ts`,
  `src/test/architecture/payroll-loan-repayment-gl.test.ts` and
  `supabase/tests/loan_gl_posting_test.sql`.

