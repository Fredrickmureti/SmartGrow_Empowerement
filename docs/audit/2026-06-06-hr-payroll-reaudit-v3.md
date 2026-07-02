# HR & Payroll Re-Audit v3 — Wave 1.1 Phase A close-out

**Date:** 2026-06-06
**Status:** Wave 1.1 Phase A shipped. Phase B (`department`, `position`, `insurance_premium`, `other_allowances` columns) explicitly deferred to a dedicated turn.

## Honest scope decision

The plan called Wave 1.1 "drop 6 legacy `employees` columns + cut over ~55 files" as a single turn. After re-mapping the call graph I split it into two phases because the columns have very different blast radii:

| Phase | Columns | Why grouped |
|---|---|---|
| **A — shipped this turn** | `basic_salary`, `housing_allowance`, `transport_allowance` | Pure-compensation columns. Backfill into `employee_contracts.{wage,housing_allowance,transport_allowance}` was already complete. `buildEmployeePayload` already declined to write them. Form has no `<Input>` rendering them. Compute-payroll never used their values (only contract values feed the math). Safe to drop. |
| **B — deferred** | `department`, `position`, `insurance_premium`, `other_allowances` | Each one needs work this turn could not deliver cleanly: `department/position` are text columns still rendered as labels and need data migration into `departments`/`job_positions` first; `insurance_premium` is consumed by `compute-payroll`'s `EMPLOYEE_INPUT_REGISTRY` and has no `employee_contracts` home yet; `other_allowances` is a JSONB additive earnings bag that some payslip paths still read. |

A partial drop is the correct enterprise call here — it eliminates the single biggest drift surface (basic salary + the two named allowances) without risking a half-converted system.

## What shipped — verified live

### Migration (`supabase`)
1. Dropped `trg_log_employee_compensation_change` + `log_employee_compensation_change()` (legacy compensation logger).
2. Dropped `employees.basic_salary`, `employees.housing_allowance`, `employees.transport_allowance`. Verified via `information_schema.columns` → 0 rows for those names.
3. Regenerated `public.v_employees_safe` (security_invoker view). Legacy column names `basic_salary`, `housing_allowance`, `transport_allowance` are still exposed but now sourced from the `active_contract` CTE — i.e. from `employee_contracts.{wage, housing_allowance, transport_allowance}`. All PII masking + `user_can_view_employee_private/_payroll` gates preserved exactly as before. `GRANT SELECT` to `authenticated` and `service_role` re-applied.
4. Created `log_contract_compensation_change()` + `trg_log_contract_compensation_change` on `employee_contracts` — fires `AFTER INSERT OR UPDATE OF wage, housing_allowance, transport_allowance, other_allowances`. `employee_compensation_history` continues to receive change rows; the source of the change moves from the legacy employees columns to the contract.

DB verification (`information_schema` + `pg_trigger`):
```
employees_legacy_cols           = (none)
v_employees_safe_compcols       = basic_salary,housing_allowance,transport_allowance
trg_log_contract_compensation_change = 1
trg_log_employee_compensation_change = 0
```

### Code (5 files)
- `src/components/employees/EmployeeFormDialog.tsx` — removed `basic_salary / housing_allowance / transport_allowance` from `EmployeeFormData` type, `emptyForm()` defaults, and `fromEmployee()` initializer. The form had no `<Input>` rendering these (the Payment Info tab already shows a banner pointing users to the active contract); the fields were dead state.
- `src/hooks/useEmployeeProfile.ts` — typed compensation fields as nullable and annotated their new source (active contract via `v_employees_safe`).
- `src/lib/importConfigs/employeeImportConfig.ts` — removed `basic_salary` from the importer field list. Importer comment now directs users to contract import.
- `supabase/functions/compute-payroll/index.ts` — removed `basic_salary, housing_allowance, transport_allowance` from the `employees` `.select(...)` chain. Values were already unused; the contract row is the only consumed source. No math change.
- `src/test/architecture/employees-no-legacy-comp-cols.test.ts` — **new** architecture guard. Fails CI if any production `.from("employees").select(string)` chain ever re-introduces a reference to one of the dropped column names. Passes today.

### Test verification
Ran the affected architecture suites:
- `employees-no-legacy-comp-cols.test.ts` — PASS (new).
- `employees-lifecycle-writes.test.ts` — PASS (pre-existing; covers UPDATE chains).
- `payroll-engine-contracts.test.ts` (6 tests) — PASS.
- `payroll-payslip-shape.test.ts` (1 test) — PASS.
- `payroll-completion-guards.test.ts` (19 tests) — PASS.

## What is NOT done (Phase B, the next turn)

| # | Column | Required work before drop |
|---|---|---|
| B1 | `employees.department` (text) | Backfill any non-null values into `departments` rows (already done per prior audit, needs spot-check). Replace `EmployeeFormDialog` "Department" select to write `department_id` only. Cut over `EmployeeHistoryTimeline` diff display. Drop column. |
| B2 | `employees.position` (text) | Same shape as B1 but against `job_positions`. `useEmployees` and `EmployeeProfile` already prefer `job_position_id` joins; only the legacy text label needs migration. |
| B3 | `employees.insurance_premium` (numeric) | Add `insurance_premium` to `contract_compensation_components` as a `component_code='insurance_premium'` row (or to a new `employee_statutory_inputs` table). Repoint `compute-payroll`'s `EMPLOYEE_INPUT_REGISTRY` to read from the new location. Backfill. Drop column. |
| B4 | `employees.other_allowances` (jsonb) | Verify it is fully redundant with `contract.other_allowances`. Update `compute-payroll` and `payslip_lines` emit paths. Drop column. |

## Next in the build queue (unchanged from approved plan)

Turn 2 — Wave 2.4 / 2.4-bis: loan + advance deduction integrity inside `approve_payroll_run`.

## Build-queue close-out evidence

```
-- After migration
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='employees'
   AND column_name IN ('basic_salary','housing_allowance','transport_allowance');
-- → 0

SELECT column_name FROM information_schema.columns
 WHERE table_name='v_employees_safe'
   AND column_name IN ('basic_salary','housing_allowance','transport_allowance')
 ORDER BY column_name;
-- → basic_salary, housing_allowance, transport_allowance
```
