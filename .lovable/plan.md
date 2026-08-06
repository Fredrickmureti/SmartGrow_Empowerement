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
- **Phase C3 — Payment reversal brought under the settlement engine**: `void_payment_atomic` and `unreconcile_payment_atomic` now own JE reversal, header update, invoice recompute (from the live allocation sum) and the ADR 0012 event in one transaction; both are period-guarded and idempotent. `useTransactionReversal` no longer deletes allocation rows, writes `invoices.amount_paid`, or treats the reversal event as best-effort; the `decrementInvoicePaid` helper is deleted. Two new ratchets guard both shapes. See `docs/adr/0125-payment-reversal-single-writer.md`.
- **Reallocation append-only proof (was remaining item 3)** — verified: `reallocate_payment_atomic` appends compensating negative rows and never UPDATEs or DELETEs allocations (ADR 0027 invariant 5).
- **`record_bill_payment_atomic` review (was remaining item 2)** — resolved: the function no longer exists in `pg_proc` and no `src/**` or `supabase/functions/**` code references it. AP settlement has a single writer, `record_multi_bill_payment`.

## Corrections to the previous engineer's claims

- "Phase 5 not started / POS lives in client `useState` with no `pos_payment_sessions` table" — **false**. The table, the RPC set and the async GL path all exist.
- "Phase 6 remaining: `employee_advances` posting path" — accurate; now closed on both legs.

## Currently active

Nothing in flight. Phase C3 is complete: typecheck clean (`tsgo --noEmit`), architecture ratchets green (7/7 in `journal-posting-monopoly.test.ts`).

## Remaining work

1. **Historical advance backfill** (needs a business decision, not code). Advances disbursed before Phase C have no journal. `disburse_employee_advance` is idempotent and safe to replay per advance, but the funding account and period must be chosen deliberately — do not bulk-post blindly. Advances partially recovered before Phase C2 also carry recovery credits against `advance_recovery_payable`; those need a one-off reclass to the receivable.
2. **Reversal regression coverage.** The new RPCs have ratchets but no pgTAP behavioural tests. Add cases under `supabase/tests/` for: void with multiple allocations (invoice returns to `partial`/`sent` correctly), double void (returns `already_voided`, no second reversal JE), void in a closed period (raises), and unreconcile leaving compensating rows rather than deleting.
3. **Sweep the remaining reversal surfaces.** `voidInvoice` in the same hook still composes several client steps (JE reversal, status update, cascade to payments, optional credit note, stock restore). It is the last multi-step settlement sequence in the browser and is the natural Phase C4.

## Instructions for the next agent

1. **Verify before you build.** Do not trust this prose. Re-read `void_payment_atomic` and `unreconcile_payment_atomic` with `pg_get_functiondef`, confirm the period guard and idempotency branches are present, and run `bunx vitest run src/test/architecture/journal-posting-monopoly.test.ts` plus `tsgo --noEmit`. Confirm `decrementInvoicePaid` is gone from `src/hooks/useTransactionReversal.ts`.
2. **Then resume chronologically at remaining item 2** (pgTAP coverage for the reversal RPCs), which closes Phase C3 to production-ready, and only then start Phase C4 (item 3, `voidInvoice`). Item 1 is blocked on a business decision — raise it with the user rather than acting on it.
3. Do not open unrelated areas of the system, and do not leave a phase partially implemented.
4. Update this file immediately after each implementation.


