# HR & Payroll — Independent Re-Audit (2026-06-06, v2)

Companion audit document to `.lovable/plan.md`. Tracks per-ship status of the
HR & Payroll re-audit build queue.

## Verified existing controls (no change required)

| Item | Status | Evidence |
|---|---|---|
| Posted/paid/reversed payroll-run + payslip immutability | **Working** | `payroll_runs_immutability_guard`, `payslips_immutability_guard`, `payslip_lines_immutability_guard` all lock only generic columns; payment-batch bypass allow-lists `status/paid_at/payment_reference/updated_at`. |
| Country-agnostic statutory engine | **Working** | No `*_kenya` or `*_paye` SQL function in `pg_proc`; statutory rules driven by `payroll_statutory_rules` + localization packs. |
| Maker-checker on payroll approval | **Working** | `enforce_payroll_maker_checker` requires `approved_by ≠ created_by` unless workspace `payroll_self_approval_policy` allows it. |
| Atomic payroll reversal | **Working** | `payroll_reverse_run_atomic` + stack-context bypass. |
| Exit-clearance triggers final settlement | **Working** | `handle_exit_clearance_completion`. |
| Nightly leave accrual cron | **Working** | `cron.job` row `process-leave-accruals-nightly` (SQL-only). |

## Withdrawn findings from the previous agent

* `C-PAY-4` (payslip-immutability statutory-leak) — trigger no longer
  references `paye/nhif/nssf_employee/housing_levy`. Withdrawn.
* `C-PAY-5` (drop legacy `calc_paye_kenya`) — no matching row in `pg_proc`.
  Withdrawn.
* `C-PAY-6` (PDF wrap-hint leak) — closed by previous agent's own
  follow-up; verified.

## Shipped this pass

### C-HR-3 — Two-level leave approval (2026-06-06)

Status: **Shipped end-to-end.** See previous entry in repo history.

### C-HR-4 — PII masking on `employees` (2026-06-06)

Status: **Shipped end-to-end.**

* New table `public.employee_credentials (employee_id PK, kiosk_pin_hash, …)`.
  RLS deny-all to `authenticated`; only `service_role` and SECURITY DEFINER
  RPCs touch it. `employees.kiosk_pin_hash` dropped after backfill.
* `set_employee_kiosk_pin` and `attendance_kiosk_clock` rewritten to read/write
  the new credential table.
* Permission helpers `user_can_view_employee_private(uuid, uuid)` and
  `user_can_view_employee_payroll(uuid, uuid)` — both STABLE SECURITY DEFINER,
  mapping to `super_admin/owner/admin/has hr.write|delete` (private) and
  `super_admin/owner/admin/has payroll.read` (payroll).
* View `public.v_employees_safe` (security_invoker) — surfaces every employee
  column plus joined `department_name`, with PII columns NULL-masked when the
  caller is neither self nor permission-bearing.
* Column-level `REVOKE SELECT` on `employees`: `national_id, date_of_birth,
  personal_phone, gender, marital_status, address_line1/2, city, county,
  postal_code, country, emergency_contact_name/phone/relationship, bank_name,
  bank_branch, bank_account_number, bank_code` from `authenticated`.
* `get_employee_pii(uuid)` SECURITY DEFINER RPC — gated on self OR
  (private AND payroll), writes an `employee.pii.read` row to `audit_logs`
  with the actor, organization, business, employee id+name, and accessed
  field families.
* Code cutover: `useEmployees`, `useCurrentEmployee`, `useEmployeeProfile`,
  and `useEmployeePayrollReadiness` now SELECT from `v_employees_safe`
  instead of `employees`. New hook `useEmployeePii(id, enabled)` wraps the
  audited RPC for "Reveal sensitive details" affordances.
* Architecture guard `src/test/architecture/no-raw-employees-pii-select.test.ts`
  forbids `.from("employees").select("*"…)` and explicit PII column selects
  outside the allow-listed PII reader hook.
* pgTAP test `supabase/tests/employee_pii_masking_test.sql` asserts the view,
  GRANTs/REVOKEs, SECURITY DEFINER attribute on `get_employee_pii`, and the
  deny-all on `employee_credentials`.

## Build queue (remaining)

1. C-HR-5 + C-HR-6 — drop duplicate compensation and org-dimension columns
   from `employees` after backfilling from contracts and FK columns.
2. H-PAY-9 — `payroll_runs.locked_at/locked_by` + stamp trigger.
3. H-PAY-10 — move HR-relevant pg_cron JWTs into `vault.decrypted_secrets`.
4. H-HR-6 — probation-confirmation surfacing.
5. H-HR-7 — final-settlement reconciliation view.
6. H-HR-8 — manager-cycle guard on `employees.manager_id`.
7. M-PAY-6 — retro-pay engine.
8. M-HR-9, M-HR-10, Lows.
