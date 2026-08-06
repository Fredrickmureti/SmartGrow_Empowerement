# Settlement Posting Convergence — Remediation Status

Authoritative status file. Roadmap source: `.lovable/plan/settlement-posting-convergence-audit-verdict-and-remediation-2026-08-06.md`.

## Completed and verified

- **Phase 1 — Posting monopoly guard**: architecture test `src/test/architecture/journal-posting-monopoly.test.ts` blocks new raw journal inserts, direct settlement-row inserts, the phantom `invoice_payments` table, and (new) client-side advance disbursement.
- **Phase 2 — Convert offenders (100%)**: re-verified this round by scanning `pg_proc` for raw `INSERT INTO journal_entries|journal_entry_lines`. Only the engine trio (`post_journal_entry_atomic`, `void_journal_entry_atomic`, `update_journal_entry_atomic`) touches journal tables directly.
- **Phase 3 — Reconciliation demoted**: `reconcile_bank_transaction_atomic` validates and matches; it no longer mints payments.
- **Phase 4 (F1–F4)**: M-Pesa webhook and loan interest accrual route through the canonical engines.
- **Phase 4 (F5) — Expense settlement**: `post_expense_gl` + `resolve_expense_default_account` own account resolution, input-tax splitting, posting and link-back server-side; `src/lib/finance/expenseSettlement.ts` is the single client entrypoint.
- **Phase 5 — POS settlement boundary**: *the previous status entry was wrong.* POS settlement is already server-side: `pos_payment_sessions` + seven lifecycle RPCs, client transport in `paymentSessionClient.ts`. Shift close posts asynchronously and durably: `_pos_stmt_enqueue_gl_post` trigger → `accounting_events` → `outbox-dispatcher` → `accounting_post_event` → `post_pos_statement_gl` → `post_journal_entry_atomic`. No POS path composes journal lines in the browser.
- **Phase 6 — Retire legacy writers**: `record_payment_atomic` is a thin shim over `record_multi_invoice_payment`; the redundant 15-arg overload is gone; the redundant 6-arg `employee_loan_apply_repayment` overload is now dropped (callers pass the terminal-event args explicitly).
- **Phase C — Employee advances brought into the GL**: new `public.disburse_employee_advance(advance_id, payment_account_id, disbursement_date)` performs the status transition and posts `Dr advance receivable / Cr bank` through the engine, idempotently, with `employee_advances.journal_entry_id` link-back. `useEmployeeAdvances.disburseAdvance` now calls the RPC instead of writing `status = 'disbursed'`. See `docs/adr/0124-employee-advance-settlement.md`.
- **Phase C2 — Advance recovery leg closed**: `process_payroll_advance_recoveries` is the only writer of `advance_repayment_schedule` and the advance balance/status (idempotent per `(advance, run)`); `payroll_advance_recovery_gl_targets` resolves the receivable account; `post-payroll-gl` credits it instead of `advance_recovery_payable`; `payroll_required_gl_mappings_for_run` now requires the advance receivable (accepting `loan_receivable` as the documented fallback) rather than a payable. `process_payroll_loan_deductions` was repaired to call the 8-arg repayment signature.

## Corrections to the previous engineer's claims

- "Phase 5 not started / POS lives in client `useState` with no `pos_payment_sessions` table" — **false**. The table, the RPC set and the async GL path all exist.
- "Phase 6 remaining: `employee_advances` posting path" — accurate; now closed on both legs.

## Remaining work

1. **Historical advance backfill.** Advances disbursed before this change have no journal. `disburse_employee_advance` is idempotent and safe to replay per advance, but the funding account and period must be chosen deliberately — do not bulk-post blindly. Advances partially recovered before Phase C2 also carry recovery credits against `advance_recovery_payable`; those need a one-off reclass to the receivable.
2. **`record_bill_payment_atomic` review** — confirm it is a shim over `record_multi_bill_payment` rather than a parallel implementation.
3. **Reallocation append-only proof** — verify `reallocate_payment_atomic` writes compensating rows and never UPDATEs allocations (ADR 0027 invariant 5).

## Instructions for the next agent

1. Do not trust status prose — re-verify with `pg_proc` scans and by reading the RPC bodies, as this round did.
2. Start at remaining item 2; items 2–3 are verification, item 1 needs a business decision on historical data.
3. Update this file immediately after each implementation.

