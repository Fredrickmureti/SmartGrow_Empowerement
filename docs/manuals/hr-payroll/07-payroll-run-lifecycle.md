# 07 · Payroll Run Lifecycle

## Purpose
End-to-end story of a single `payroll_runs` row from creation to terminal state. Every transition has an exact code path.

## Run types

| `run_type` | When to use | Uniqueness |
|---|---|---|
| `regular` | Normal monthly/biweekly payroll | **Unique per `(org, business, period)`** — duplicate attempts return 409 with `recovery_options[]` |
| `off_cycle` / `bonus` / `commission` / `13th_month` / `termination` | One-off or in-cycle additions | Can coexist with the regular run |
| `supplemental` / `correction` | Fix a closed run | Require `parent_run_id` pointing at a `posted/approved/paid` run |

## State diagram

```text
        ┌─ readiness blockers? ──► (no create — 400)
[create]
        ▼
   ┌─ duplicate regular for period? ─► 409
   ▼
   period closed? ─► 409
   ▼
   exit clearance blocking? ─► 409 (termination runs)
   ▼
   pending corrections? ─► 409
   ▼
   dry_run? ──yes──► preview { totals, lines, blockers }   [no DB writes]
   │
   no
   ▼
   INSERT payroll_runs (status="draft")
   INSERT payslips + payslip_lines      [FATAL on failure → rollback]
   INSERT payslip_inputs                [non-fatal]
   INSERT payroll_run_issues            [skipped rules, blockers]
   Drain retro_pay_adjustments          [non-fatal]
   process_payroll_loan_deductions RPC  [FATAL on failure → rollback]
   INSERT payroll_work_entries          [non-fatal]
   attendance_lock_for_period RPC       [non-fatal]
   Stamp expenses.reimbursed_payslip_id, bump employee_garnishments.total_paid
   INSERT sms_event_outbox + audit_logs
   ▼
   status = "draft"
   ▼ (UI: Approve)        usePayroll.approvePayrollRun
   status = "approved"
   ▼ (UI: Post to GL)     post-payroll-gl  → JE: Dr salary expense / Cr <rule>_payable / Cr net_salary_payable
   status = "posted"
   ▼ (UI: Create Payment Batch + Mark Paid)  post-payroll-payment-gl  → Dr net_salary_payable / Cr bank
   status = "paid"
   ▼ (UI: Reverse)        reverse-payroll → payroll_reverse_run_atomic (atomic JE void + negated payslips)
   status = "reversed"   (terminal)
```

Helpers (`src/lib/payroll/runLifecycle.ts`): `getRunLifecycle()`, `canReverseRun()` — these are the single source of truth for "can I press this button?". A run can be reversed only from `posted` or `paid`, and never if `is_reversal=true`, `run_type='correction'`, or already `reversed`.

## Work entries — what feeds compute

**Source A — `attendance`**: rows where `status IN ('present','late','half_day')` AND `clock_out IS NOT NULL`. Optional approval gate (`attendance_settings.require_approval_for_payroll`). OT pre-approval gate (`require_ot_preapproval` ↔ `overtime_requests.approved`). Holiday rows contribute holiday premium / paid non-worked hours.

**Source B — Timesheets**: `contract.time_tracking_source='timesheets'`. **All** timesheets in the period must be `approved`, else blocker `TIMESHEETS_NOT_APPROVED`. Reads `v_timesheet_payroll_ready(employee_id, period_month, total_hours, locked_hours)`; prefers `locked_hours`.

**OT pay**: `hourlyRate = contract.wage / (std_working_days × hours_per_day)`; `overtimePay = hours × hourlyRate × overtime_multiplier` (default 1.5×, from `businesses.payroll_overtime_multiplier`).

## Compute walk-through (high level)

For each employee in scope:
1. Load contract (`status='running'`), salary structure, snapshot rule-set.
2. Compute proration factor:
   ```text
   totalDays = pEnd − pStart + 1
   effectiveStart = max(pStart, hire_date or contract.start_date)
   effectiveEnd   = min(pEnd, termination_date or contract.end_date)
   factor = workedDays / totalDays  ∈ [0,1]
   ```
   `factor=0` skips the employee with a warning. Overrides via `proration_overrides[employee_id]` require a reason and are logged to `payslip_inputs.source='override'`.
3. Resolve gross from rules / components (Chapter 6).
4. Apply statutory rules by dispatching on `computation_method`. Unknown methods write `payroll_run_issues(code='RULE_SKIPPED_UNKNOWN_METHOD')` — never silently zeroed.
5. Apply loans (Chapter 7 below), then garnishments (Chapter 7 below).
6. Apply retro pay deltas (`retro_pay_adjustments` queue).
7. Emit `payslips` row + per-line `payslip_lines` row.

## Loans during compute

Per active loan, with next installment from `loan_repayment_schedule` (lowest pending sequence):

| Method | Amount |
|---|---|
| `fixed_installment` | `scheduled_amount − paid_amount` |
| `percent_of_net` | `provisionalNet × percent / 100` |
| `one_off_next_payroll` | `outstanding_balance` |
| `fixed_amount` (default) | `monthly_deduction` |

Guards applied in order: `min(wanted, outstanding_balance)` → `max_pct_of_net` cap → `min_net_pay_floor` (`deduction = min(wanted, max(0, net − floor))`).
Commit via RPC `process_payroll_loan_deductions(_run_id, _payroll_number, _deductions[])` — **fatal on failure**.
Paused loans (`paused_until >= period_end`) are skipped unless a `payroll_run_loan_skip_overrides` row says otherwise.

## Garnishments during compute

```text
disposable = max(0, gross − pre_garnishment_deductions)
aggregate_cap_pool = disposable × org.aggregate_cap_pct  (∞ if null)
org_floor = max(min_take_home_amount, gross × min_take_home_pct)

for order in priority order:
  if disposableRemaining ≤ 0: break
  if counts_toward_cap AND cappedPoolRemaining ≤ 0: skip
  raw = cap_rule formula
  raw = min(raw, remaining_owed)
  reduce by projected floor breach
  capped = min(raw, disposableRemaining)
  if counts_toward_cap: capped = min(capped, cappedPoolRemaining)
  emit payslip_line(category='garnishment', source={garnishment_id})
  bump employee_garnishments.total_paid
```

## Retro pay
1. Select `retro_pay_adjustments` rows `status='pending'`, `effective_from <= period_end`, `employee_id IN scope`.
2. Insert a delta `payslips` row with `retro_of_payslip_id`, `retro_effective_from`, `basic_salary=0`, totals from `delta_*`.
3. Insert `payslip_lines` from `delta_lines` jsonb.
4. UPDATE adjustment `status='applied'`, `applied_run_id`, `applied_payslip_id`, `applied_at`. Non-fatal: failures don't roll back primary payslips.

## Multi-jurisdiction
`employees.statutory_country_code` overrides the run-level `country_code` per employee. The engine loads all countries in scope once and indexes by country, so a single run can mix KE + UG employees with no special-casing.

## Reversal
- UI: `ReversePayrollDialog.tsx` collects reason, calls edge fn `reverse-payroll`.
- Edge fn delegates entirely to RPC `payroll_reverse_run_atomic(_run_id, _user_id, _reason, _post_to_gl, _reversal_date)`.
- The RPC, in a single transaction:
  1. Inserts a negated sub-ledger run + negated payslips/lines.
  2. Voids the original JE (negating lines) — guaranteed balanced.
  3. Flips the original run to `status='reversed'`.
  4. Writes `payroll_reclassification_audit` + `audit_logs`.
- HTTP error map: `ALREADY_REVERSED→409`, `INVALID_STATE→409`, `MISSING_GL_ENTRY→422`, `PERIOD_LOCKED→409`, `NO_PAYSLIPS→422`, `42501→403`.

## Per-run audit & visibility
- `payroll_run_issues` — every skipped rule, every blocker, every warning. Surfaced in `PayrollRunDetailsDialog`.
- `payroll_readiness_findings` — per-subject blockers; surfaced before "Create".
- `payslip_inputs` — input provenance per employee per run (worked hours, proration factor, override flags).

> Full evidence: `./_research/03-payroll-engine.md`.
