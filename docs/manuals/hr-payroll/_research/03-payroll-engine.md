# Research: Payroll Engine

Source: sub-agent investigation `sub_mhk6aqpt`. Verified read-only against current codebase. Input for chapters `06-payroll-setup.md` and `07-payroll-run-lifecycle.md`.

---

## 1. High-Level Architecture
The payroll engine is a **Deno edge function** (`supabase/functions/compute-payroll/index.ts`, ~2,656 lines) backed by a PostgreSQL schema enforced by Supabase RLS. UI lives in `src/pages/hr/payroll/` and `src/components/payroll/`. Country-agnostic design is mandated by ADR-0036 and enforced by `src/test/architecture/no-hardcoded-country-payroll.test.ts`.

## 2. Tables — Purpose Map

| Table | Purpose |
|---|---|
| `payroll_runs` | One row per compute invocation. Owns `status`, `run_type`, `total_gross/net`, `deductions_summary`, `contributions_summary`, `rule_set_id/hash`, `is_reversal`, `reversed_at`, `parent_run_id`. |
| `payroll_run_groups` | Groups multiple runs (multi-company) for batch operations. |
| `payroll_run_issues` | Blockers/warnings emitted by engine. `severity ∈ {blocker, warning, info}`. Codes: `RULE_SKIPPED_UNKNOWN_METHOD`, `DEPRECATED_SENTINEL_RULE_TYPE`, `BRACKET_PROGRESSIVE_MISSING_BRACKETS`, `NO_STATUTORY_RULES_FOR_COUNTRY`, `TIMESHEETS_NOT_APPROVED`, `EXIT_CLEARANCE_INCOMPLETE`. |
| `payroll_run_loan_skip_overrides` | Per-run permission to deduct a paused loan despite `paused_until`. |
| `payroll_periods` | Named periods owned by `pay_schedules`. |
| `pay_schedules` | Frequency, payment dates per business. |
| `payslips` | One row per employee per run. Header columns (`gross_pay`, `total_deductions`, `net_pay`, `taxable_income`, `rule_set_id/version/hash`, `retro_of_payslip_id`, `retro_effective_from`). Legacy KE columns no longer written. `payslip_lines` is authoritative. |
| `payslip_lines` | Authoritative line-by-line: `rule_code`, `rule_type`, `category`, `label`, `employee_amount`, `employer_amount`, `taxable`, `sequence`, `source` (jsonb), `rule_version_id`, `rule_version_hash`. |
| `payslip_inputs` | Provenance: attendance hours, proration factor, unpaid leave, override flags. |
| `payroll_salary_rules` | Odoo-parity named salary rules. `code`, `name`, `sequence`, `category ∈ {basic,allowance,deduction,employer_contribution,net,gross,other}`, `condition_select ∈ {always,expression}`, `amount_select ∈ {fixed,percentage,expression,statutory_ref}`, `statutory_rule_id`. |
| `salary_components` | Legacy flat components used when `use_structure_engine=false`. |
| `salary_structures` | Container for a set of rules/components. `use_structure_engine` flag gates the Stage-D structure engine. |
| `salary_structure_rule_sets` | **Immutable snapshots** of a structure's rules at a point in time. `components` jsonb, `version`, `rule_hash`. Retrieved via RPC `resolve_or_publish_rule_set(p_structure_id, p_as_of)`. |
| `payroll_work_entries` | Aggregated from `attendance` or `v_timesheet_payroll_ready`. `hours`, `overtime_hours`, `holiday_hours`, `attendance_count`, `source`. Backfills `attendance.work_entry_id`. |
| `payroll_work_entry_types` | `is_paid`, `counts_as_worked`, `multiplier_normal`, `multiplier_overtime`. Used by `structureEngine.ts` `aggregateWorkedHours`. |
| `payroll_readiness_rules` / `payroll_readiness_findings` / `payroll_readiness_runs` / `payroll_readiness_rule_overrides` | Readiness evaluation + audit + per-subject waivers. `subject_type ∈ {org,business,employee,run}`. |
| `payroll_employee_ytd` | YTD accumulator per employee. Updated downstream of GL flow. |
| `retro_pay_adjustments` | Pending delta payslips. Drained by engine at commit. |
| `employee_garnishments` | `cap_rule ∈ {fixed_amount,percent_disposable,lesser_of_fixed_or_pct}`, `priority`, `kind`, `aggregate_cap_exempt`, `total_owed/total_paid`. |
| `garnishment_kind_defaults` | Per-kind policies (`always_first`, `counts_toward_aggregate_cap`, default priority). |
| `employee_loans` | `repayment_method ∈ {fixed_installment,percent_of_net,one_off_next_payroll,fixed_amount}`, `paused_until`, `min_net_pay_floor`, `max_pct_of_net`, `outstanding_balance`, `loan_type_id`. |
| `loan_types` | `code`, `salary_rule_code` (drives deduction line code), `gl_receivable_account_id`, `gl_disbursement_clearing_account_id`. |
| `loan_repayments` / `loan_repayment_schedule` | Per-run repayment history and per-installment schedule (`pending/partial/paid`). |
| `payroll_settings` | Org-level garnishment policy (`aggregate_cap_pct`, `min_take_home_amount`, `min_take_home_pct`). |

## 3. Edge Functions

- **`compute-payroll`** — primary compute engine. Sub-modules: `expressionEngine.ts` (hand-written Pratt tokenizer/parser; whitelist `BASIC, GROSS, TAXABLE, NET, employee.*, contract.*, worked_hours[code], worked_days[code], result[code]`; functions `min, max, round, if`; limits 2000 chars, 200 tokens, depth 32); `structureEngine.ts` (pure rule-graph walker).
- **`reverse-payroll`** — JWT + entitlement, delegates to RPC `payroll_reverse_run_atomic(_run_id,_user_id,_reason,_post_to_gl,_reversal_date)`. Error map: `ALREADY_REVERSED→409`, `INVALID_STATE→409`, `MISSING_GL_ENTRY→422`, `PERIOD_LOCKED→409`, `NO_PAYSLIPS→422`.
- **`generate-payslip-pdf` / `generate-payroll-document`** — PDF rendering from committed payslip data.
- **`post-loan-disbursement`** — idempotent (`source_type='loan_disbursement'`). Dr `loan_types.gl_receivable_account_id`, Cr `loan_types.gl_disbursement_clearing_account_id`. Sets `employee_loans.status='active'`, stamps `disbursed_at`, `disbursement_journal_entry_id`.
- **`post-loan-settlement`** — idempotent (`source_type='loan_settlement'`). Normal: Dr Clearing / Cr Receivable. Write-off: Dr `default_account_settings[loan_writeoff_expense|salary_expense]` / Cr Receivable. Updates `outstanding_balance`, sets `status ∈ {settled,written_off}`.

## 4. Primary Code Paths

### Pages (`src/pages/hr/payroll/`)
`Runs.tsx`, `Overview.tsx`, `SalaryStructures.tsx`, `Setup.tsx`, `Garnishments.tsx`, `LoanSkipOverrides.tsx`, `LoanTypesSettings.tsx`, `RunGroups.tsx`, `Reports.tsx`, `TaxCertificates.tsx`.

### Components (`src/components/payroll/`)
`PayrollWorkspace.tsx`, `CreatePayrollDialog.tsx`, `PayrollPreviewDialog.tsx`, `PayrollRunList.tsx`, `ReversePayrollDialog.tsx`, `PreRunReadinessSummary.tsx`, `PayrollSetupGate.tsx`, `SalaryRuleGraphEditor.tsx`, `StatutoryRuleEditor.tsx`, `PayslipDetailDialog.tsx`, `PayslipLineExplainer`, `EmployeeReadinessPanel.tsx`.

### Hooks (`src/hooks/payroll/`)
`usePayrollReadiness`, `usePayrollWorkspaceData`, `usePayrollRunGroups`, `useSalaryRules`, `useSalaryRuleSets`, `useWorkEntryTypes`, `usePayrollPayments`, `useEmployeeYtd`, `usePayrollMappingFindings`, `usePayrollGlReadiness`, `useStatutoryReturns`, `useTaxCertificates`, `useTemplateOverrides`.

### Lib (`src/lib/payroll/`)
`runLifecycle.ts` (`getRunLifecycle`, `canReverseRun`, `getLineageBadge`), `computationMethods.ts` (`COMPUTATION_METHODS` registry: 6 methods with `validate()` + field specs; plus `inferComputationMethod`, `normalizeParameters`, `suggestRuleCode`), `garnishment-engine.ts` (pure mirror of edge logic), `expressionValidator.ts`, `payslipClassifier.ts`, `payslipHeader.ts`, `bankDisbursementExport.ts`.

## 5. Run Lifecycle — State Transitions

```text
[new run request]
        │
        ▼
  assert_payroll_ready RPC ─fail→ 400 (readiness blockers)
        │ pass
        ▼
  fiscal_periods lock check ─closed→ 409
        │ open
        ▼
  run_type duplicate check ─REGULAR_RUN_EXISTS→ 409 + recovery_options[]
        │ ok
        ▼
  exit_clearance gate (termination) ─blocking→ 409
        │ ok
        ▼
  attendance pending corrections ─>0→ 409
        │ ok
        ▼
  dry_run=true → preview (no DB writes)
        │ dry_run=false
        ▼
  INSERT payroll_runs { status:"draft" }
  INSERT payslips, payslip_lines (fatal on failure → rollback)
  INSERT payslip_inputs (non-fatal)
  INSERT payroll_run_issues (skipped rules, TS blockers)
  Drain retro_pay_adjustments (non-fatal)
  process_payroll_loan_deductions RPC (fatal → rollback)
  INSERT payroll_work_entries (non-fatal)
  attendance_lock_for_period RPC (non-fatal)
  Stamp expenses.reimbursed_payslip_id, bump employee_garnishments.total_paid
  INSERT sms_event_outbox + audit_logs
        │
        ▼
   status="draft"
        │ usePayroll.approvePayrollRun
        ▼
   status="approved"
        │ post-payroll-gl
        ▼
   status="posted"
        │ CreatePaymentBatchDialog
        ▼
   status="paid"
        │ reverse-payroll → payroll_reverse_run_atomic
        ▼
   status="reversed" (terminal)
```

**`run_type` taxonomy**
- `regular` — unique per (org, business, period); duplicates blocked.
- `off_cycle`, `bonus`, `commission`, `13th_month`, `termination` — coexist with regular.
- `supplemental`, `correction` — require `parent_run_id` pointing at a `posted/approved/paid` run.

**Lifecycle helpers** (`src/lib/payroll/runLifecycle.ts`)
- `getRunLifecycle()` → `draft | approved | posted | paid | reversed | reversal | correction`.
- `canReverseRun()` — only `posted | paid`; blocked if `is_reversal=true`, `run_type='correction'`, or `status='reversed'`.

## 6. Readiness Subsystem — How It Blocks Runs

Fail-closed contract. Until `payroll_readiness_findings` has rows for the org, `isReady=false` and "New Payroll Run" is disabled.

1. `usePayrollReadiness("org")` calls RPC `payroll_readiness_blockers(p_org_id, p_business_id, p_scope, p_subject_id)` (severity `block` with `remediation_label/link`) plus a SELECT on `payroll_readiness_findings`.
2. `evaluate` mutation → RPC `evaluate_payroll_readiness(...)` writes `payroll_readiness_findings` + `payroll_readiness_runs`.
3. Engine itself calls `assert_payroll_ready` RPC before any compute (second layer).
4. Per-employee readiness surfaced via `useEmployeePayrollReadiness` → `EmployeeReadinessPanel`.
5. Per-run issues persisted to `payroll_run_issues` and visible in `PayrollRunDetailsDialog`.

## 7. Salary Rules + Structures — How They Combine

### Path A — Legacy `salary_components` (`use_structure_engine=false`)
Two-pass: fixed first, then percentage (`resolvedComponents[code] = base * rate`). Base fallback: `basic` defaults to `contract.wage`. Components mapped to `basicSalary / housingAllowance / transportAllowance / otherEarnings` by code name.

### Path B — Structure Engine (`use_structure_engine=true`)
`compute-payroll/structureEngine.ts`:
1. Snapshot via RPC `resolve_or_publish_rule_set(p_structure_id, p_as_of=pay_period_end)` → returns frozen `salary_structure_rule_sets.components` (byte-identical recompute).
2. `aggregateWorkedHours(entries, types)` → `worked_hours[typeCode]`, `worked_days[typeCode]` respecting `is_paid`, `multiplier_normal/overtime`.
3. Rules in `sequence` order: condition (`always` / expression), amount (`fixed`, `percentage`, `expression`, `statutory_ref`). Running accumulators: `basic`, `gross`, `taxable`, `deductions`, `employer` per category. `ctx.result[rule.code] = amount` available to later rules.
4. Errors pushed to `errors[]`, non-fatal per line.

### Statutory Rules (`payroll_statutory_rules`)
Loaded per country in one query (active + effective + non-superseded). Dispatch in `computeOneRule`:

| `computation_method` | Algorithm |
|---|---|
| `bracket_progressive` | Marginal-rate slices on taxable income; subtracts `personal_relief` + `insurance_relief_rate × premium` (capped at `insurance_relief_max`). |
| `tiered_brackets` | Per-tier flat % on slab; separate `employee_rate`/`employer_rate` per tier. |
| `percentage_of_gross` | Single or split rate on `pickBase(params.base)`. |
| `graduated_table` | Flat amount lookup from band table. |
| `flat_amount` | Fixed, employee-only or employer-only. |
| `per_employee_flat` | Employer-only flat per active employee (NITA-style). |

Unknown method → `skippedRuleSink` → `payroll_run_issues` (never silently zeroed).
**Taxable adjustments** (e.g., housing exemption) declared inline on PAYE rule `parameters.taxable_income_adjustments[]`. The legacy `rule_type='housing_exemption'` sentinel was removed; engine emits `DEPRECATED_SENTINEL_RULE_TYPE` if still seen.
**Multi-jurisdiction**: `employees.statutory_country_code` overrides run-level `country_code` per employee. Engine groups countries, indexes rule sets, supports KE+UG employees in one run.

## 8. Work Entries → Compute

**Source A — `attendance`**
- `attendance` where `status IN ('present','late','half_day')` AND `clock_out IS NOT NULL`.
- Optional approval gate (`attendance_settings.require_approval_for_payroll → approved_by IS NOT NULL`).
- OT pre-approval gate (`require_ot_preapproval → overtime_requests.approved` cap per employee).
- Holiday rows (`status='holiday'`) contribute holiday premium / paid non-worked hours.
- Rolled into `attendanceByEmployee[empId]{ totalWorkedHours, totalOvertimeHours, totalHolidayHours, daysPresent, daysHoliday }`.

**Source B — Timesheets** (`contract.time_tracking_source='timesheets'`)
- All timesheets in period must be `approved`; else `TIMESHEETS_NOT_APPROVED` blocker.
- Reads `v_timesheet_payroll_ready(employee_id, period_month, total_hours, locked_hours)`. Prefers `locked_hours`.
- Replaces attendance aggregate for that employee.

**OT pay calculation**
If `varEarnings.overtime_pay = 0` and attendance has OT:
`hourlyRate = contract.wage / (std_working_days × hours_per_day)`, then `overtimePay = hours × hourlyRate × overtime_multiplier` (default 1.5×, from `businesses.payroll_overtime_multiplier`).

`payroll_work_entries` written after commit; `attendance.work_entry_id` backfilled.

## 9. Retro Pay (`retro_pay_adjustments`)
1. Select `pending` rows where `employee_id IN run_employees` AND `effective_from <= pay_period_end`.
2. Insert delta `payslips` row with `retro_of_payslip_id`, `retro_effective_from`, `basic_salary=0`, amounts from delta totals.
3. Insert `payslip_lines` from `delta_lines` jsonb.
4. `UPDATE retro_pay_adjustments SET status='applied', applied_run_id, applied_payslip_id, applied_at`.
Non-fatal: failures don't roll back primary payslips.

## 10. Garnishments — Interaction with Compute
Load order: `garnishment_kind_defaults` → `payroll_settings` → `employee_garnishments` (active, date-range) sorted `always_first` then `priority` then `start_date`.

```text
disposable = max(0, gross − pre_garnishment_deductions)
aggregate_cap_pool = disposable × org.aggregate_cap_pct (∞ if null)
org_floor = max(min_take_home_amount, gross × min_take_home_pct)

for each order (priority-sorted):
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

## 11. Loans — Interaction with Compute
Active loans + `loan_types(code, salary_rule_code)`; next installment from `loan_repayment_schedule[status IN ('pending','partial')]` lowest `sequence`.

| Method | Amount |
|---|---|
| `fixed_installment` | `scheduled_amount − paid_amount` |
| `percent_of_net` | `provisionalNet × percent / 100` |
| `one_off_next_payroll` | `outstanding_balance` |
| `fixed_amount` (default) | `monthly_deduction` |

Guards: `min(wanted, outstanding_balance)`; `max_pct_of_net` cap; `min_net_pay_floor` (deductionAmt = `min(wanted, max(0, net − floor))`).
Deduction code: `loan_types.salary_rule_code` → else `loan_repayment_{type.code}` → else `loan_repayment`.
Commit: `process_payroll_loan_deductions(_payroll_run_id, _payroll_number, _deductions[])` RPC — **fatal** on failure.
Pause: `loan.paused_until >= pay_period_end` → skip; per-run override via `payroll_run_loan_skip_overrides`.

## 12. Country-Agnostic Completion (ADR-0036)

Architecture guard `src/test/architecture/no-hardcoded-country-payroll.test.ts` forbids tokens `paye, nhif, nssf, housing_levy, sha_` (non-comment / non-string) inside `compute-payroll`, `post-payroll-gl`, `generate-payslip-pdf`, `generate-payroll-document`, `reverse-payroll`, `post-loan-*`, `payrollData.ts`, `usePayroll.ts`, `useEmployeeLoans.ts`, `src/pages/hr/payroll/`. Allowlist: `install-localization-pack/`, `generate-localization-statutory-document/`, `localization/seeds/`.

Implementation mechanisms:
1. **`EMPLOYEE_INPUT_REGISTRY`** maps token → `(employee) => number`. New statutory input = one-line change + `requires_input` in pack rule.
2. **`computation_method` dispatch** — engine never branches on country.
3. **`taxable_income_adjustments[]`** inside PAYE rule `parameters` replaces deprecated `rule_type` sentinel.
4. **`employees.statutory_country_code`** per-employee jurisdiction override.
5. Localization packs hydrate `payroll_statutory_rules`.
6. **`salary_structure_rule_sets`** snapshot → byte-identical recompute.

Additional architecture tests: `compute-payroll-uses-rule-set.test.ts`, `assert-payroll-ready-single-overload.test.ts`, `no-hardcoded-payroll-role-matrix.test.ts`, `no-country-switch-in-payroll-ui.test.ts`, `no-dropped-payroll-tables.test.ts`.

## 13. Proration
```text
totalDays = (pEnd − pStart).days + 1
effectiveStart = max(pStart, hire_date or contract.start_date)
effectiveEnd   = min(pEnd, termination_date or contract.end_date)
factor = workedDays / totalDays  (clamped 0..1)
```
Contract clamping: if `contract.start_date < hire_date`, engine uses `hire_date` and emits a warning.
Override: `proration_overrides[employee_id].{full_period:true, reason}` forces `factor=1`; requires reason; logged to `payslip_inputs.source='override'`.
`factor=0` → employee skipped for period (warning, no payslip).

## 14. GL Integration

| Action | Function |
|---|---|
| Post payroll | `post-payroll-gl` (`usePayrollGL.postPayrollToGL`) |
| Post payment | `post-payroll-payment-gl` |
| Post remittance | `post-remittance-payment` |
| Loan disbursement | `post-loan-disbursement` |
| Loan settlement / write-off | `post-loan-settlement` |
| Reversal | RPC `payroll_reverse_run_atomic` (GL void inside transaction) |

GL readiness pre-checked via `usePayrollGlReadiness` + `PayrollGlReadinessBanner`.
