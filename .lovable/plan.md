## Verification of the previous engineer's work

I re-ran every proof named in `.lovable/plan.md` against the live database and the current source. All five phases hold — no rework needed, no superficial patch.

- **Phase 1 — one terminal status (`completed`).**
  `SELECT count(*) FROM employee_loan_state_transitions WHERE to_status='settled'` → 0.
  `SELECT count(*) FROM employee_loans WHERE status='settled'` → 0.
  `employee_loan_settle()` writes `status='completed'`, calls `_loan_assert_transition('settle')`, and emits `loan_log_event('settle', prior, 'completed')`.
  Client mirror in `src/lib/hr/loanStateMachine.ts` no longer uses `settled`. The only remaining `'settled'` literals in `src/` belong to the unrelated `legal_order_remittance_batch_status` enum and the auto-generated `types.ts` — not the loan domain.

- **Phase 2 — canonical repayment-apply RPC.**
  `employee_loan_apply_repayment(loan_id, amount, payroll_run_id, payslip_id, kind, notes)` exists (SECURITY DEFINER, `search_path=public`, EXECUTE granted to `authenticated`/`service_role`) and is the sole write path for a payroll instalment.

- **Phase 3 — payroll is a caller, not an owner.**
  Live body of `process_payroll_loan_deductions` is exactly a loop that delegates to `employee_loan_apply_repayment`; zero `UPDATE public.employee_loans` and zero status literals inside it.

- **Phase 4 — events and audit parity.**
  `loan_log_event` is called on every repayment; the outbox key/payload shape is present in the migration and the SQL guard checks it.

- **Phase 5 — regression protection.**
  `supabase/tests/loan_payroll_repayment_test.sql`, `src/test/architecture/payroll-loan-repayment-lifecycle.test.ts`, `.../employee-loan-lifecycle.test.ts`, `.../payroll-loan-repayment-gl.test.ts`, and `src/lib/hr/__tests__/loanStateMachine.test.ts` all exist. `useMyLoans.ts` now uses `employee_loan_cancel` (no direct status write).

The end-to-end proof the previous plan couldn't run headlessly (drive a real final-instalment payroll run and observe `completed` + lifecycle events + GL posting) is still worth doing once as part of milestone (a) below; nothing in the code suggests it will fail, but it hasn't been observed on a live tenant yet.

## Continuation — remaining lifecycle surface

The previous plan explicitly named the next milestones. Reading the current DB functions confirms each is still real work, not already done:

- `employee_loan_reverse_repayment` still mutates `employee_loans.amount_repaid`, `outstanding_balance`, `installments_paid` directly and rewrites `loan_repayment_schedule` inline. That is exactly the parallel-writer pattern Phase 2/3 removed for payroll — it is the last surviving second write path into loan state.
- There is no canonical settle-on-termination RPC. `pending_termination_payouts` is consumed as a payroll input by `compute-payroll`, and `close_on_termination` is a legal state transition, but no function closes an outstanding loan through the same single write path Finance already trusts.
- `employee_loan_clear_arrears` is called on repayment, but nothing puts a loan **into** `in_arrears` when a scheduled instalment is missed. `loan_repayment_schedule.status` is the source of truth and has no watcher.

### Phase 6 — Termination settlement (canonical single path)

- New RPC `employee_loan_close_on_termination(_loan_id, _termination_date, _reason, _payroll_run_id, _payslip_id)`:
  - Locks the loan, asserts status ∈ repayable set, runs `_loan_assert_transition('close_on_termination')`.
  - If `outstanding_balance > 0`, delegates to `employee_loan_apply_repayment` with `kind='termination_writeoff'` (or `termination_recovery` when the balance is being deducted from final pay via `pending_termination_payouts`) so the balance is zeroed through the same code path Phase 2 established. No direct `UPDATE employee_loans`.
  - After apply, transitions to `closed_on_termination` (or `completed` if balance was fully recovered from final pay) via the state machine, and emits `loan_log_event('close_on_termination', …)`.
- `consume_pending_termination_payouts` (or `compute-payroll` termination branch) calls the new RPC instead of inlining any balance math.
- `loan_repayments.kind` gets the new value(s) added via migration; Finance posting registry (`payroll_loan_repayment_gl_targets` / `_loan_split_repayment`) is extended so write-off flows through a bad-debt / termination-writeoff GL account (ADR 0091 rules 1–2 preserved — Finance still owns posting; the loan module only records the event).
- Regression: `supabase/tests/loan_termination_settlement_test.sql` (terminated employee with outstanding balance → single canonical apply, terminal status, one JE, one outbox event) + `src/test/architecture/loan-termination-single-writer.test.ts` (asserts no code writes `employee_loans.status='closed_on_termination'` outside the new RPC).

### Phase 7 — Arrears detection (scheduled)

- New RPC `employee_loan_mark_missed_installments(_as_of date)` (SECURITY DEFINER, idempotent):
  - Selects `loan_repayment_schedule` rows with `due_date < _as_of AND status='pending'` whose loan is in `active`.
  - For each affected loan, transitions via `_loan_assert_transition('enter_arrears')` and calls `loan_log_event('enter_arrears', …)` with the missed instalment ids on the payload.
- Schedule via `pg_cron` daily job (`select cron.schedule(...)`) or a TanStack server route under `src/routes/api/public/loans-arrears-sweep.tsx` protected by an HMAC header, whichever matches this repo's existing scheduler pattern (I'll follow whichever is used by `payroll_readiness_eval_rule_core` / the fx-revaluation job to stay consistent).
- Clearing already exists (`employee_loan_clear_arrears`); no changes needed there.
- Regression: pgTAP that an overdue pending row promotes the loan to `in_arrears` exactly once, and that clearing on the next successful repayment restores `active`.

### Phase 8 — Reverse-repayment parity (kill the last parallel writer)

- Rewrite `employee_loan_reverse_repayment` as the strict inverse of `employee_loan_apply_repayment`:
  - Lock loan → assert reversible (original not already reversed, loan not `archived`).
  - Insert the negative-amount `loan_repayments` row (kept — this is the audit trail).
  - De-allocate the affected `loan_repayment_schedule` rows through a new helper `_loan_deallocate_schedule(_repayment_id)` that mirrors the FIFO allocator.
  - Recompute `amount_repaid`, `outstanding_balance`, `installments_paid` from `loan_repayments` aggregates (no drift-prone in-place arithmetic).
  - If the loan was previously `completed` because of the original repayment, transition back via `_loan_assert_transition('reopen')` (add that transition if not already present).
  - Emit `loan_log_event('reverse_repayment', prior, new, amount, reason, payload)` — payload keeps `repayment_id`, `reversal_id`, `journal_entry_id`.
  - Finance mirror-JE logic stays where it is (already canonical via `post_journal_entry_atomic`).
- Regression: pgTAP asserting apply → reverse → apply is a fixed point (balances, schedule, and events return to the pre-apply state), plus a client-side architecture test that no code outside the loan module reads or writes `loan_repayment_schedule`.

### Cross-cutting

- Add the three new event names (`loan.termination_settled`, `loan.entered_arrears`, `loan.repayment_reversed`) to `business_event_topics` if not already there, and to the outbox key convention `loan:<loan_id>:<event_id>`.
- Update ADR 0091 with rules 12–14 codifying: (12) termination settlement uses the canonical apply path, (13) arrears is derived from `loan_repayment_schedule`, not stored by hand, (14) reversal is the exact inverse of apply and uses no direct table writes.
- Update `mem://index.md` with a Core rule: *loan state (status, balance, schedule, arrears) is written only by the loan module through `employee_loan_apply_repayment` / `employee_loan_reverse_repayment` / lifecycle RPCs — no other module updates `employee_loans` or `loan_repayment_schedule`*.
- Before starting Phase 6, run the deferred end-to-end proof from the previous plan (one payroll run whose employee is on their final instalment) and record the observed outcome in the plan log.

### Order & verification gates

Phase 6 → Phase 8 → Phase 7 (termination and reversal both feed the arrears watcher's fixed-point tests). After each phase:

- `bunx vitest run src/test/architecture/employee-loan-lifecycle.test.ts src/test/architecture/payroll-loan-repayment-lifecycle.test.ts src/test/architecture/loan-*.test.ts src/lib/hr/__tests__/loanStateMachine.test.ts`
- Re-query DB: no `UPDATE public.employee_loans` outside the loan module, no `UPDATE public.loan_repayment_schedule` outside the loan module, terminal statuses still `completed | cancelled | archived | closed_on_termination | defaulted` (with `defaulted` only reachable via the state machine).
- `tsgo -p tsconfig.app.json` clean.

### Non-goals (unchanged from the previous plan)

- Do not widen or drop `employee_loans_status_check`.
- Do not re-introduce `settled`.
- Do not add a second repayment write path.
- Do not post GL from the loan module — Finance owns posting (ADR 0091 rules 1–2).

## Technical notes

- `pending_termination_payouts.consumed_run_id` is the idempotency key for termination recovery from final pay; Phase 6 relies on it and does not add a second one.
- The arrears sweep only reads `loan_repayment_schedule` and calls the state machine — it never touches balances, keeping single-writer discipline intact.
- Reverse-repayment's schedule de-allocation must be transactional with the negative `loan_repayments` insert; both live inside one RPC.
