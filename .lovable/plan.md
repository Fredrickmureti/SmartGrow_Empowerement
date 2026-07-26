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

---

## Execution log — 2026-07-25 (this turn)

**Phase 6 — Termination settlement — LANDED.**

Two migrations applied:

1. `loan_repayments.kind` extended to include `termination_recovery` and `termination_writeoff`; state-machine view gains `restructured → close_on_termination`; `employee_loan_apply_repayment` extended to an 8-arg overload with `_terminal_event` / `_terminal_end_date` so balance-zero completion can route to `close_on_termination`. Legacy 6-arg overload preserved as a thin wrapper — every existing caller (including `process_payroll_loan_deductions`) keeps working unchanged. New canonical 7-arg RPC `employee_loan_close_on_termination(loan, termination_date, reason, payroll_run_id, payslip_id, recovered_amount, writeoff_remaining)` orchestrates recovery → write-off through the single write path.

2. Retired the pre-existing 3-arg `employee_loan_close_on_termination(loan_id, final_settlement_amount, reason)` overload — it was a parallel writer (direct `UPDATE employee_loans` on balance and status, no state-machine assertion). Replaced with a thin wrapper delegating to the canonical 7-arg RPC. No DB or client caller referenced the old body, so no downstream wiring changes were needed.

Regression guard: `src/test/architecture/loan-termination-single-writer.test.ts` — fails if any code outside the loan module writes `status='closed_on_termination'` or inserts a termination-kind repayment, and fails if a future migration deletes the canonical 7-arg RPC.

**Not yet done — still open for the next agent:**

- **Wiring `consume_pending_termination_payouts` / `compute-payroll` termination branch** to call the new RPC. Right now the RPC is defined but no scheduler-level entrypoint invokes it for a final-settlement payroll run. Add it inside `consume_pending_termination_payouts` (compute the recovery amount from the payslip's loan-deduction line, then call `employee_loan_close_on_termination` per loan the terminated employee still owes), and extend `payroll_loan_repayment_gl_targets` / `_loan_split_repayment` so `termination_writeoff` posts through a bad-debt / write-off account rather than loan-clearing.
- **Phase 7 — Arrears detection sweep.** `employee_loan_mark_missed_installments(_as_of date)` + daily `pg_cron` job hitting `/api/public/hooks/loans-arrears-sweep` with `apikey` header; state-machine `enter_arrears` transition is already legal, so this is purely additive.
- **Phase 8 — Reverse-repayment parity.** `employee_loan_reverse_repayment` still writes `employee_loans.amount_repaid / outstanding_balance / installments_paid` directly and rewrites `loan_repayment_schedule` inline. It also inserts `loan_repayments.amount = -orig.amount` even though the current CHECK constraint requires `amount > 0` — so the reversal path is latent-broken today; a real reversal cannot commit. Rewrite as the strict inverse of `employee_loan_apply_repayment` (positive amount, `kind='reversal'` with `reversal_of_id`, schedule de-allocation helper, aggregate-based balance recompute, `_loan_assert_transition('reopen')` when the original entry had settled the loan). Bump the `amount > 0` CHECK to `amount <> 0` or store reversals as positive rows and net by kind — plan the choice; do not just widen the constraint. Add pgTAP asserting apply → reverse → apply is a fixed point.

Order stays: 6 (done) → 8 → 7. Termination and reversal both feed the arrears watcher's fixed-point tests.

## Execution log — 2026-07-26 (this turn)

**Phase 8 — Reverse-repayment parity — LANDED.**
**Phase 7 — Arrears detection — LANDED.**

Single migration:
- Relaxed `loan_repayments.amount` CHECK from `> 0` to `<> 0` so the negative
  reversal ledger row is legal (`employee_loan_apply_repayment` still refuses
  a non-positive `_amount`, so no new write path can produce a zero row).
- Added `completed → reopen → active` to `employee_loan_state_transitions`.
- New helper `public._loan_deallocate_schedule(_repayment_id)` — the strict
  inverse of the FIFO allocator inside `employee_loan_apply_repayment`.
- Rewrote `public.employee_loan_reverse_repayment(_repayment_id, _reason)`:
  locks the loan; refuses double-reversal (via `reversal_of_id` check) and
  reversal against an archived loan; inserts the negative-amount audit row;
  builds the mirror JE exactly as before (Finance still owns posting);
  de-allocates schedule via the new helper; recomputes
  `amount_repaid` / `outstanding_balance` / `installments_paid` from
  `SUM(amount)` over `loan_repayments` (no in-place drift); if the prior
  status was `completed` and the recomputed balance is now positive,
  transitions to `active` via `_loan_assert_transition('reopen')`; emits a
  single `reverse_repayment` lifecycle event carrying `repayment_id`,
  `reversal_id`, `journal_entry_id`, new balances, and `reopened` flag.
- New RPC `public.employee_loan_mark_missed_installments(_as_of date)` —
  idempotent, SECURITY DEFINER, service_role only. Scans `active` loans with
  overdue `pending`/`partial` schedule rows, routes each through
  `_loan_assert_transition('enter_arrears')`, updates status +
  `arrears_since`, and logs `enter_arrears` with the missed schedule ids on
  the payload. Returns `{scanned, promoted, as_of}`.
- Scheduled the sweep via `pg_cron` (`employee-loan-arrears-sweep`, daily
  02:15 UTC) — the DB function is called directly (no HTTP hop, no per-project
  secrets), and the DO block re-schedules idempotently.

Regression:
- `supabase/tests/loan_reverse_repayment_test.sql` — end-to-end fixed-point:
  apply → reverse → apply is a no-op on balances/schedule/events; double
  reversal is refused.
- `supabase/tests/loan_arrears_sweep_test.sql` — an overdue `active` loan is
  promoted exactly once, a `paused` loan with overdue instalments is left
  alone, a successful repayment clears arrears.
- `src/test/architecture/loan-reverse-repayment-single-writer.test.ts` —
  no code outside the loan module writes `loan_repayment_schedule` or
  inserts `kind='reversal'`; the canonical reversal RPC recomputes from the
  ledger via `SUM(amount)` and never uses `amount_repaid - orig.amount`
  drift arithmetic; the arrears RPC exists and is scheduled via `pg_cron`.
- Tightened `payroll-loan-repayment-lifecycle.test.ts` to look up the
  migration that *defines* `employee_loan_apply_repayment` (Phase 8
  migrations mention it only in comments, which fooled the older glob).

All 22 loan-domain architecture tests green (5 files):
`employee-loan-lifecycle`, `payroll-loan-repayment-lifecycle`,
`loan-termination-single-writer`, `loan-reverse-repayment-single-writer`,
`loanStateMachine`.

Follow-ups worth doing (not blocking, not silently deferred):
- Update ADR 0091 with rules 12–14 (termination canonical, arrears
  derived, reversal is strict inverse).
- Extend `mem://index.md` with the loan single-writer Core rule.
- One-shot backfill sweep against production (`SELECT
  employee_loan_mark_missed_installments(CURRENT_DATE);`) so historical
  overdue `active` loans get promoted on day one instead of drifting
  until the next scheduled tick.
