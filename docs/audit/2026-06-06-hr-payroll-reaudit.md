# HR & Payroll Re-audit + C-HR-2 Closeout

**Date:** 2026-06-06
**Status:** Phase 1 (re-verification) + C-HR-2 shipped.

## Re-verification of prior agent's claims

| Claim | Result | Evidence |
|---|---|---|
| C-HR-1 — `handle_exit_clearance_completion` trigger | **PASS** | `pg_proc` def inspected: only fires on transition INTO `completed`; blocks on `employee_loans.status IN ('active','suspended') AND outstanding_balance > 0` with hint `exit_clearance_unsettled_loans`; idempotent via `NEW.final_pay_run_id IS NOT NULL` short-circuit; inserts `payroll_runs` with `run_type='final_settlement'`, `is_final_settlement=true`, `final_settlement_employee_id=NEW.employee_id`, `business_id` inherited from clearance row → employee, `pay_period_start = date_trunc('month', last_working_day)`, `payment_date = last_working_day`. SECURITY DEFINER + `SET search_path=public`. Bound as `trg_exit_clearance_completion`. |
| C-HR-1 client wiring | **PASS** | `useExitClearance.completeClearance()` exists at `src/hooks/useExitClearance.ts:241`; consumed by `EmployeeTerminationDialog.tsx:195`. |
| C-PAY-3 — `approve_payroll_run` maker-checker | **PASS** | `created_by = auth.uid()` raises `42501` with hint `payroll_maker_checker_violation` unless `user_has_payroll_admin_override(...)`. Also validates GL mappings via `validate_payroll_run_mappings` before approval. |
| `process_leave_accruals` function | **PASS (with caveats)** | Honors `accrual_enabled`, `accrual_rate`, `accrual_frequency` (monthly/quarterly/semi_annual/annual), caps YTD at `carryover_limit`, idempotent per (employee × leave_type) via MAX(created_at) + interval anchor. |
| Reversal atomicity (`payroll_reverse_run_atomic`) | **PASS** | Present in `pg_proc`. |

### Caveats found in `process_leave_accruals` (not blockers)

- `accrual_frequency='anniversary'` falls through to monthly default — not yet implemented (no `employees.hire_date`-anchored branch). Flag as **L-HR-4**.
- `carryover_deadline` column (text) is never consulted for expiry of unused carryover — flag as **L-HR-5**.
- Anchor uses `MAX(allocation.created_at)` rather than calendar-month/quarter start; an org running the job late will skew the next-due date. Acceptable for nightly cron at fixed `01:30` but worth documenting — flag as **L-HR-6**.

These do not block enterprise readiness for the common monthly/annual case but should be cleared in a follow-up wave.

## Newly identified Critical/High gaps (appended to `.lovable/plan.md`)

- **C-PAY-4** — Posted payroll runs/payslips are not immutable: no BEFORE UPDATE trigger blocks direct edits to `payslips`, `payslip_lines`, or `payroll_runs.{gross,net}` once `status IN ('posted','paid','reversed')`. The reverse-run RPC is the only sanctioned path, but a direct PostgREST UPDATE with sufficient RLS would succeed.
- **C-HR-4** — Employee PII (`national_id`, `bank_account_number`, `kra_pin`, `nssf_no`, `shif_no`) is selectable by every role with `employees` read. Needs column-level masking (view + role gate).
- **H-PAY-9** — `payroll_runs.locked_at` / `locked_by` not stamped on approval.
- **H-HR-6** — `employee_contracts.probation_end_date` not surfaced via scheduled job → HR misses confirmation deadlines.
- **H-HR-7** — `pending_termination_payouts` table has no reconciliation against created final-settlement runs.
- **M-PAY-6** — No retro-pay engine; back-dated `employee_compensation_history` changes are not replayed.
- **M-HR-8** — `employees.supervisor_id` chains have no cycle-guard trigger; org chart can self-reference.

## C-HR-2 shipped

- Scheduled `pg_cron` job **`process-leave-accruals-nightly`** (jobid 32) at `30 1 * * *` running `SELECT public.process_leave_accruals(NULL);` — pure SQL, no `pg_net` round-trip, no anon-key exposure in `cron.job.command`.
- Function already idempotent + cap-aware per re-verification above; no patch needed.
- Manual "Run accrual now" button in `useLeaveAccruals` continues to work (uses the same RPC) — preserved for HR on-demand re-runs.
- Smoke: trigger an off-cycle execution any time with `SELECT public.process_leave_accruals(NULL);` and inspect `leave_allocations` (`allocation_type='accrual'`) + `cron.job_run_details WHERE jobid = 32`.

## Next in queue

Per the approved plan: **C-PAY-1** (bank disbursement file export: Pesalink CSV + generic CSV) → **C-PAY-2** (SoD permission split) → **C-PAY-4** (posted-run immutability) → **C-HR-3** (two-level leave approval) → **C-HR-4** (PII masking) → then the High and Medium queues.

## C-PAY-1 shipped (2026-06-06, follow-up)

- New module **`src/lib/payroll/bankDisbursementExport.ts`** — pure CSV
  builders (`buildPesalinkCsv`, `buildGenericCsv`) + `fetchBankExportRows`
  (joins `payroll_payment_batch_items` → `employees` for bank metadata) +
  `exportBatchToBankFile` orchestrator + browser `triggerCsvDownload`.
- **Pesalink CSV** columns: `BeneficiaryName, BankCode, BranchCode,
  AccountNumber, Amount, Currency, Reference, Narration` — canonical
  Kenyan bulk-upload order. Bank+branch code split via `splitBankCode`
  helper (`BBB-BBBB` or first-2/rest fallback).
- **Generic CSV** columns: full employee + bank wide layout for ad-hoc
  internet-banking portals.
- UI: added per-row dropdown (Pesalink CSV / Generic CSV) to
  `PayrollPaymentsPage` table (`src/pages/hr/payroll/sections.tsx`).
  Always-on regardless of batch status (treasury frequently re-downloads
  for reconciliation against bank statement); the "Mark paid" controls
  remain gated by `payPayroll` + non-terminal status.
- Toast surfaces `missingBankCount` so treasury sees data-quality issues
  (employees without `bank_account_number`) before pushing the file.
- No DB migration required — uses existing `payroll_payment_batches` /
  `payroll_payment_batch_items` schema.

## Next in queue

C-PAY-2 (SoD split of `managePayroll` into create/approve/post/pay) →
C-PAY-4 (posted-run immutability triggers) → C-HR-3 → C-HR-4.

---

## C-PAY-2 close-out (2026-06-06)

**Server-tier SoD for Post & Pay shipped.**

DB (migration applied):
- `user_has_module_permission` extended to honour `pgr.can_pay` for the `pay` op.
- `user_can_post_payroll(user, org, run)` rewritten on top of the group-permission model + maker-checker block (poster ≠ creator OR approver, with admin-override escape). Previously only the legacy `accountant` base role could post — group-based posters were silently rejected.
- New `user_can_pay_payroll(user, org, run)` enforcing `payroll.pay` AND payer ≠ creator/approver/poster, with admin override.
- `GRANT EXECUTE` to authenticated/service_role for both helpers.

Edge functions:
- `post-payroll-gl` now calls `user_can_post_payroll` before any write. SoD violations return `403 PERMISSION_DENIED hint=payroll_post_sod_violation`.
- `post-payroll-payment-gl` (which previously had NO module-permission check at all) now calls `user_can_pay_payroll`. SoD violations return `403 PERMISSION_DENIED hint=payroll_pay_sod_violation`.

UI tier (`usePayrollPayments`, `usePayroll`, `PayrollRunList`, `PayrollRunDetailsDialog`) already gates on `canPayPayroll` / `canPostPayrollGL` / `canApprovePayroll`, so no UI changes required. Hint-aware copy can be added to `lib/edgeFunctionError.ts` in a follow-up — current generic "permission denied" copy still surfaces correctly.

**Next in queue:** C-PAY-4 (posted-run immutability trigger).

---

## C-PAY-4 close-out (2026-06-06)

**Posted-run immutability triggers shipped.**

New BEFORE-UPDATE / BEFORE-DELETE triggers freeze the financial contents of any payroll run once `status ∈ ('posted','paid','reversed')`:
- `trg_payroll_runs_immutable` — blocks edits to total_gross / total_other_deductions / total_employer_contributions / total_net / employee_count / period dates / run_type / org / business on the run header.
- `trg_payslips_immutable_upd` / `trg_payslips_immutable_del` — blocks edits to financial columns and any delete on payslips. The payment-batch path (`current_setting('app.payroll_payment_via_batch') = 'on'`, set by `post-payroll-payment-gl`) is allowed to stamp `status`, `paid_at`, `payment_reference`, etc. but cannot touch amounts.
- `trg_payslip_lines_immutable_upd` / `trg_payslip_lines_immutable_del` — blocks any write on payslip lines belonging to a terminal run.

The controlled rewrite paths (`payroll_reverse_run_atomic`, `payroll_reclassify_run`) are recognised by `PG_CONTEXT` call-stack inspection and allowed to mutate balances atomically. No custom GUC was used (Supabase blocks unregistered `ALTER FUNCTION ... SET app.*`).

All triggers RAISE EXCEPTION with ERRCODE 42501 + a stable HINT (`payroll_run_immutable`, `payslip_immutable`, `payslip_line_immutable`) so client-side mapping in `lib/edgeFunctionError.ts` can surface specific copy in a follow-up.

**Next in queue:** C-HR-3 (two-level leave approval) or C-HR-4 (PII column masking on employees).
