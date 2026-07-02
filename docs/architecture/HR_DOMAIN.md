# HR Domain Architecture

The HR domain is **NOT one app**. It is a domain composed of **five independently
installable apps**, mirroring Odoo's `hr`, `hr_holidays`, `hr_attendance`,
`hr_payroll`, `hr_recruitment` modules.

## Apps

| App ID         | Name         | Depends on        | Status        | Self-service surface                        |
| -------------- | ------------ | ----------------- | ------------- | ------------------------------------------- |
| `employees`    | Employees    | (none — root)     | Shipped       | `/me/profile`                               |
| `time_off`     | Time Off     | `employees`       | Shipped       | `/me/leave`                                 |
| `attendance`   | Attendance   | `employees`       | Shipped       | `/me/attendance`, `/me/timesheets`          |
| `payroll`      | Payroll      | `employees`       | Shipped       | `/me/payslips`                              |
| `recruitment`  | Recruitment  | `employees`       | Coming soon   | (n/a)                                       |

`Employees` is the foundation of the entire domain. The other four list it as
a hard dependency, so `install_app('payroll')` will transitively install
`employees` if missing. Uninstalling `employees` is blocked while any
dependent HR app is installed (`DEPENDENCY_BLOCKED` raised by `uninstall_app`).

## URLs

The legacy `/hr/*` URLs continue to resolve via a thin dispatcher
(`src/apps/hr/routes.tsx`) that mounts each sub-app's own `Routes` component.
Each sub-app has its own `AppShell`, so the in-app topbar shows only the
modules that belong to *that* sub-app — Payroll users don't see Recruitment
links and vice versa.

Self-service is **deliberately hoisted out of HR** into `MeApp` at `/me/*`.
Employees with portal-only access never enter an HR app shell — they live in
`MeApp`, which is route-gated by `OwnProfileOrPermissionRoute`.

## Permissions vs Entitlement

These are **two independent layers** that must both pass:

1. **Entitlement** — does the org's plan/trial/override grant the app?
   Resolved by `check_org_app_access(p_org_id, p_app_id)` and the
   `useAppAccess.getAppEntitlementState` 5-state model.
2. **RBAC** — does *this user* have permission for the action?
   Resolved by `user_has_module_permission(_user_id, _org_id, _module, _operation)`,
   which combines the user's app-role base grants with explicit
   `permission_group_rules` rows.

A tenant subscribed to Payroll does **not** automatically grant every user
access to Payroll. The seeded permission groups make this explicit:

| Group              | Employees | Time Off | Attendance | Payroll      | Recruitment |
| ------------------ | --------- | -------- | ---------- | ------------ | ----------- |
| Internal User      | RW        | RW       | RW         | RW           | RW          |
| HR Manager         | RW        | RW       | RW         | **R only**   | RW          |
| Payroll Admin      | R         | RW       | R          | RW           | —           |
| Payroll Officer    | R         | —        | R          | R + Create   | —           |
| Attendance Officer | R         | —        | RW         | —            | —           |
| Time Off Officer   | R         | RW       | —          | —            | —           |
| Accountant         | —         | —        | —          | R+W (post)   | —           |
| Portal User        | —         | self     | self       | —            | —           |

Backend payroll RPCs (`compute-payroll`, `post-payroll-gl`, `reverse-payroll`,
`generate-payslip-pdf`) all call `requireModulePermission` server-side, so a
front-end bypass cannot reach payroll data.

## Branch scoping

Employees are organization-scoped. Their **assignments** to branches live in
`user_branch_assignments` and individual contracts can be branch-scoped.
Payroll runs accept a `business_id` and `assert_payroll_ready` filters
contracts/account mappings by it.

For branch-restricted users (e.g. branch managers), the HR hooks
(`useEmployees`, `useAttendance`, `useLeaveRequests`, `usePayroll`) call
`assertHrScope` from `src/lib/hr/scopingAssertions.ts` to warn during
development when a query lacks the expected branch filter. This is **not** a
security boundary — RLS + `requireModulePermission` remain authoritative.

## Setup readiness

Each installed app has a row in `app_setup_status` (per-org, per-app) with
`status` and `blocking_reasons`. For Payroll, `refresh_payroll_setup_status`
populates this from: localization pack installed, salary structure exists,
payroll GL account mappings exist, statutory rules configured, at least one
active contract.

The frontend reads this via `useAppSetupStatus` and renders:
- An amber "Setup required" sub-row on marketplace tiles.
- `<PayrollSetupGate>` inside the Payroll page that blocks the run dialog
  with an actionable checklist + deep links.

## Read-only on uninstall

Uninstalling an HR app sets `organization_installed_apps.is_active = false`.
Historical rows (`payslips`, `payroll_runs`, `employee_loans`, leave records,
attendance records) are **never deleted**. RLS keeps them readable; the
`assert_app_installed_for_write` trigger blocks new INSERT/UPDATE/DELETE
against those tables until the app is reinstalled.

## Contract-first proration and the `period_id` flow

`compute-payroll` treats the active `employee_contracts` row as the source
of truth for the employment window. `employees.hire_date` is HR/tenure
metadata only and is overridden when `contract.start_date < hire_date`
(provenance `startSource = "contract_overrides_hire_date"`). This eliminates
the class of bugs where a UI default for `hire_date` caused early periods to
be skipped or partial-month proration to be applied to a full-month
employment.

`payroll_runs.period_id` is the FK to `payroll_periods`. When supplied,
`compute-payroll` derives `pay_period_start`/`pay_period_end` from the period
row and refuses to run against `locked` or `closed` periods. The
`payroll_periods` non-overlap exclusion constraint prevents duplicate windows
per `(business_id, period_type)`.

## Settings source of truth: `v_payroll_settings_effective`

Standard working days, hours per day, and overtime multiplier live in
`payroll_settings`. The `v_payroll_settings_effective` view returns one
effective row per business, preferring `payroll_settings.*` over the
deprecated `businesses.payroll_standard_*` columns. The engine and all UI
writers must read this view; the legacy columns remain for one release
window before being dropped.

## Employee advances (first-class)

Cash advances issued outside a payroll run are tracked in
`employee_advances` and recovered via `advance_repayment_schedule`.
`compute-payroll` applies advance recovery after loans and before
garnishments, honoring each advance's `min_net_floor`. Lump-sum advances
recover the full outstanding balance in the next run; installment advances
recover `installment_amount` per period until fully recovered.

## Deprecated tables

- `payroll_remittances` — superseded by `payroll_liabilities` +
  `payroll_remittance_payments`. Do not write from new code.
- `employments` — superseded by `employee_contracts`. Do not write from
  new code.

Both are flagged by `COMMENT ON TABLE` and by the
`no-deprecated-payroll-tables-read` architecture guard.
