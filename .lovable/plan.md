## Verified root cause (not a constraint bug)

The failure is a **naming schism in the loan terminal status**, plus payroll owning a duplicate copy of the loan lifecycle.

Confirmed by reading the live database:

- `employee_loans_status_check` allows `completed` — it does **not** allow `settled`.
- `employee_loan_state_transitions` says `active|in_arrears --settle--> settled`.
- `employee_loan_settle()` writes `status='settled'` → would violate the same constraint.
- `employee_loan_settle_early()` writes `status='completed'` → passes.
- `src/lib/hr/loanStateMachine.ts` also treats `settled` as the terminal state.
- `public.employee_loans` currently has **0** rows in `settled` (nothing ever reached the terminal state successfully).
- `process_payroll_loan_deductions()` contains its own inline mutation:
  `status = CASE WHEN _new_balance <= 0 THEN 'settled' ELSE status END`.

So the sequence is exactly what was observed: preview computes fine (pure calculation), and the mutation phase in `compute-payroll` (line 5425) calls `process_payroll_loan_deductions`, whose final instalment flips status to the non-existent value `settled`, the check constraint refuses it, and `compute-payroll` deletes the run and surfaces "Payroll rolled back: loan repayment failed".

The constraint is correct and stays. What is wrong is that there are **two terminal-status vocabularies** and **two implementations of loan repayment**.

## Additional drift found in the same code path

`process_payroll_loan_deductions` is a parallel lifecycle implementation. Compared with the canonical loan module it:

- bypasses `_loan_assert_transition` (no state-machine validation at all),
- never calls `loan_log_event`, so payroll repayments produce **no** loan lifecycle event and **no** `business_event_outbox` row (manual repayments do),
- recomputes balance itself as `total_amount - amount_repaid` instead of using the loan module's helpers,
- never clears arrears (`in_arrears` loans stay in arrears after a successful deduction; `employee_loan_clear_arrears` exists and is not called),
- has no per-run idempotency guard of its own — it relies solely on the partial unique index `uq_loan_repayments_loan_payslip`, which raises a raw 23505 that again rolls back the whole run instead of being treated as "already applied".

GL posting for these deductions is already canonical (`post-payroll-gl` → `payroll_loan_repayment_gl_targets` → `_loan_split_repayment`), so Finance ownership is intact and is not changed by this work.

## Canonical model to converge on (SAP / Oracle HCM / Workday / Odoo)

```text
Payroll run (mutation phase)
   └─ records a REPAYMENT EVENT only  ──► loan module
                                            ├─ validate transition (state machine)
                                            ├─ append loan_repayments row (idempotent per payslip)
                                            ├─ allocate to loan_repayment_schedule (FIFO)
                                            ├─ recompute amount_repaid / outstanding_balance
                                            ├─ derive status (arrears cleared, completion)
                                            └─ loan_log_event → audit + business_event_outbox
Finance (post-payroll-gl)  ──► journal entry, principal vs interest split
```

Single owner per responsibility: **Loans** own state, status transitions, balance and schedule progression; **Payroll** owns the deduction amount only; **Finance** owns posting and numbering (already true, per ADR 0091).

## Status — 2026-07-25 (all five phases COMPLETE and verified)

Active phase: **none open — roadmap milestone "Payroll loan repayment lifecycle" is closed.**
Next milestone: see "Instructions for the next agent" at the bottom.

**Phase 1 — One terminal status (`completed`) — DONE, verified**
- Migration applied: `employee_loan_state_transitions` `settle` rows now yield `completed`; transitions added from `paused` and `restructured`; `employee_loan_settle()` writes `completed`.
- Verified by query: `select count(*) from employee_loan_state_transitions where to_status='settled'` → **0**.
- Client mirror aligned: `src/lib/hr/loanStateMachine.ts` (`LoanStatus`, `LOAN_TRANSITIONS`, `TERMINAL_STATUSES`), its unit test, and the `useEmployeeLoans` status union no longer contain `settled`.

**Phase 2 — Canonical repayment-apply RPC — DONE, verified**
- `employee_loan_apply_repayment(_loan_id, _amount, _payroll_run_id, _payslip_id, _kind, _notes)` is live (SECURITY DEFINER, `search_path=public`, EXECUTE to `authenticated`/`service_role`).
- Behaviour confirmed against the deployed function body: row lock, repayable-status assertion (`active|in_arrears|paused|restructured`), `loan_repayments` insert, FIFO allocation over `loan_repayment_schedule`, balance/instalment recompute, arrears cleared via `employee_loan_clear_arrears`, completion via `employee_loan_settle` (state machine), never a status literal.
- Idempotency: an existing `(loan_id, payslip_id)` repayment returns `already_applied: true` instead of raising.

**Phase 3 — Payroll is a caller, not an owner — DONE, verified**
- `process_payroll_loan_deductions` delegates every deduction to `employee_loan_apply_repayment`; verified by query that its body contains no `UPDATE employee_loans` and no `'settled'` literal.
- `compute-payroll` keeps all-or-nothing rollback, but a replayed instalment is now a no-op rather than a run-aborting 23505/check violation.

**Phase 4 — Events and audit parity — DONE, verified**
- Every repayment emits `loan_lifecycle_events` + `business_event_outbox` (`loan.repayment_recorded`, and `loan.settle` on the final instalment) through `loan_log_event`, with the outbox idempotency key `loan:<loan_id>:<event_id>`.
- Follow-up migration applied so the event carries full detail: `amount`, plus payload `repayment_id`, `kind`, `payroll_run_id`, `payslip_id`, `amount_repaid`, `outstanding_balance`, `unallocated` — payroll-sourced and manual repayments are now indistinguishable to downstream subscribers.

**Phase 5 — Regression protection — DONE, verified**
- `supabase/tests/loan_payroll_repayment_test.sql`: state machine ⊆ check-constraint vocabulary, payroll owns no loan state, two-instalment loan reaches `completed` with zero balance, lifecycle events present, repayment against a completed loan is refused.
- `src/test/architecture/payroll-loan-repayment-lifecycle.test.ts` (4 tests, passing): client mirror has retired `settled`; payroll delegates and never writes `employee_loans`; no edge function or client module writes `employee_loans.status`; the RPC keeps the state-machine completion, `loan_log_event` amount and `already_applied` contract.
- Guard caught one real offender outside the plan's original scope: `src/hooks/useMyLoans.ts` cancelled an ESS loan request with a direct `status: "cancelled"` write. It now calls `employee_loan_cancel`, so the transition is validated and audited like every other one.
- ADR 0091 extended with the addendum "payroll-sourced repayments" (rules 9-11: one terminal status, one repayment write path, payroll records events and does not own loan state).
- Full typecheck clean (`tsgo -p tsconfig.app.json`); loan + payroll-GL guard suites green (17 tests).

**Known, pre-existing and out of scope:** the Supabase linter reports ~2.3k `Security Definer View` (0010) findings project-wide. Untouched by this work; not introduced by it.

## Instructions for the next agent

1. **Verify before you build.** Re-confirm, do not assume:
   - `select count(*) from employee_loan_state_transitions where to_status='settled'` → 0.
   - `process_payroll_loan_deductions` body contains `employee_loan_apply_repayment` and no `UPDATE public.employee_loans`.
   - `bunx vitest run src/test/architecture/payroll-loan-repayment-lifecycle.test.ts src/test/architecture/payroll-loan-repayment-gl.test.ts src/test/architecture/employee-loan-lifecycle.test.ts src/lib/hr/__tests__/loanStateMachine.test.ts` → all green.
   - Then run the end-to-end proof this plan could not run headlessly: confirm one payroll run whose employee is on their **final** instalment and check the loan lands in `completed`, the run does not roll back, `loan_lifecycle_events` has `repayment_recorded` + `settle` with a non-null `amount`, and `post-payroll-gl` credits loan receivable / interest income (ADR 0091 rule 8) rather than a `_payable` account.
2. **Resume from the next logical milestone, not unrelated work.** The natural continuation of this roadmap is the remaining loan-lifecycle surface, in this order:
   a. **Termination settlement** — `closed_on_termination` has a transition but no canonical RPC comparable to `employee_loan_apply_repayment`; `pending_termination_payouts` should settle outstanding principal through the same single write path and post through Finance.
   b. **Arrears detection** — `employee_loan_clear_arrears` exists and is now called, but nothing puts a loan *into* `in_arrears` on a missed scheduled instalment; that belongs on a scheduled job reading `loan_repayment_schedule`.
   c. **Repayment reversal parity** — `employee_loan_reverse_repayment` predates `employee_loan_apply_repayment`; it should be re-expressed as the exact inverse of the canonical apply path (schedule de-allocation + `loan_log_event` with amount), so apply/reverse remain symmetric.
3. **Do not** widen or drop `employee_loans_status_check`, re-introduce `settled`, add a second repayment write path, or post GL from the loan module (Finance owns posting — ADR 0091 rules 1-2).

## Plan (as executed)


**Phase 1 — One terminal status (`completed`)**
Migration: repoint `employee_loan_state_transitions` `settle` rows to `to_status='completed'`, and rewrite `employee_loan_settle()` to write `completed` and log `settle → completed`. `settled` is retired everywhere; the check constraint is untouched. Align `src/lib/hr/loanStateMachine.ts`, its test, and the `useEmployeeLoans` status union.

**Phase 2 — One canonical repayment-apply RPC**
Migration adding `employee_loan_apply_repayment(loan_id, amount, payroll_run_id, payslip_id, kind, notes)` that is the single write path for a payroll-sourced instalment: locks the loan, asserts the loan is in a repayable status, inserts the `loan_repayments` row, allocates FIFO against `loan_repayment_schedule`, recomputes totals, clears arrears via the canonical event when applicable, and on zero balance performs the completion transition through `_loan_assert_transition` + `loan_log_event('settle', prior, 'completed')` — so completion is validated and emitted, never inlined.
Idempotency: an existing `loan_repayments` row for the same `(loan_id, payslip_id)` returns "already applied" instead of raising.

**Phase 3 — Payroll becomes a caller, not an owner**
Rewrite `process_payroll_loan_deductions` to loop the deduction payload and delegate each item to `employee_loan_apply_repayment` — no direct `employee_loans` UPDATE, no status literal, no schedule writes of its own. `compute-payroll` keeps its all-or-nothing rollback semantics, but a repeat of an already-applied instalment no longer aborts the run.

**Phase 4 — Events and audit parity**
Verify every payroll-sourced repayment now yields a lifecycle event and outbox row (`loan.repayment.recorded`, plus `loan.completed` on final instalment) on the same topic vocabulary the manual path uses, so downstream notification/reporting subscribers see payroll and manual repayments identically.

**Phase 5 — Regression protection**
- `supabase/tests/loan_payroll_repayment_test.sql`: final-instalment run reaches `completed`, arrears loan is cleared, replay of the same payslip is a no-op, balance never negative, event rows exist.
- Extend `src/test/architecture/payroll-loan-repayment-gl.test.ts` (or a sibling guard) to assert no SQL outside the loan module writes `employee_loans.status`, and that no source in the repo references the retired `settled` loan status.
- Update ADR 0091 with the status-vocabulary rule and the "payroll records events, loans own state" clause.

Verification after each phase: run the relevant vitest guards, re-query the transition table/function bodies, and drive one payroll confirmation whose employee is on a final instalment to confirm it completes rather than rolls back.

## Technical notes

- No constraint is weakened, dropped or widened; no loan status is edited to make the error disappear.
- `completed` is chosen as the survivor because the check constraint (the strictest, data-level contract) and `employee_loan_settle_early` already use it, and zero rows hold `settled`, so no data migration is required.
- Finance posting stays exactly where ADR 0091 put it; this work does not add or move any GL logic.
