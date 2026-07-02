# HR / Employees / Payroll — Architecture Contract

## TL;DR

The HR domain is **not one app**. It's split into 5 Odoo-aligned, independently
installable apps that share the `/hr/*` URL space:

| App ID         | Odoo equivalent     | Owns                                                       | Depends on              | Status        |
|----------------|---------------------|------------------------------------------------------------|-------------------------|---------------|
| `employees`    | `hr`                | Directory, departments, contracts, HR reports              | —                       | Foundation    |
| `time-off`     | `hr_holidays`       | Leave types, allocations, public holidays, approvals       | `employees`             | Available     |
| `attendance`   | `hr_attendance`     | Clock-in oversight, work schedules, timesheet approvals    | `employees`             | Available     |
| `timesheets`   | `hr_timesheet`      | Project time approvals, time-billing reports               | `employees`             | Available     |
| `payroll`      | `hr_payroll`        | Salary structures, runs, payslips, loans, remittances, GL  | `employees` + `finance` | Available     |
| `recruitment`  | `hr_recruitment`    | Job posts, applicants, hiring pipeline                     | `employees`             | Coming soon   |

`Employees` is the foundation: every other HR-domain app declares it as a
dependency and installing any of them auto-installs Employees. It carries no
add-on price — it's the root of the HR data model and must always be present
before payslips, leave balances, or timesheet rows can exist.

## Why split

A single "HR & Payroll" megamodule was rejected for three reasons:

1. **Money safety.** Payroll touches the GL. Bundling it with leave/attendance
   meant any tenant with HR installed had implicit access to payslip data
   regardless of whether they intended to run payroll. Splitting lets RBAC and
   entitlement gate Payroll independently.
2. **Setup discipline.** Payroll requires contracts, statutory rules, salary
   structures, and a Finance integration before a single payslip can be
   computed. Making Payroll its own installable app (with explicit deps)
   means the "Run Payroll" button only appears after the prerequisites are
   in place — enforced by `assert_payroll_ready` server-side.
3. **Pricing alignment with Odoo.** Tenants pay only for what they use.
   A small business that wants employee records + leave but outsources
   payroll should not be billed for or confused by Payroll surfaces.

## URL space

All five apps mount under `/hr/*` to preserve deep links and webhook URLs.
The dispatcher in `src/apps/hr/routes.tsx` routes each top-level segment to
the correct sub-app and wraps it in `<AppInstalledGate appId="…">`:

```
/hr/dashboard|employees|departments|contracts|reports  → employees
/hr/leave/*                                            → time-off
/hr/attendance/*, /hr/work-schedules/*                 → attendance
/hr/timesheets/*  (admin)                              → attendance (timesheet approvals surface)
/hr/payroll/*, /hr/remittances/*, /hr/settings        → payroll
/hr/recruitment/*                                      → recruitment

/hr/my-portal, /hr/my-profile, /hr/timesheets (self), /hr/documents
                                                       → redirect to /me/*
```

Each sub-app brings its own `HrAppShell` + `AppDefinition`, so the workspace
topbar always shows the correct module list — there is no URL-segment
sniffer. The previous monolithic `HRLayout.resolveHrApp()` has been removed.

## Self-service vs admin

| Surface       | URL          | Gate                                        | Audience                 |
|---------------|--------------|---------------------------------------------|--------------------------|
| Admin HR      | `/hr/*`      | `InternalOnlyRoute` + `AppInstalledGate` + `PermissionProtectedRoute` | Internal users with HR roles |
| Self-service  | `/me/*`      | `PortalUserRoute`                           | Portal users + internal users with employment record |

Portal users **cannot** reach `/hr/*` business surfaces. The hard boundary is
enforced by `internalOnly: true` on every HR sub-app's `AppDefinition`. Even
if a permission is mistakenly granted, `InternalOnlyRoute` blocks the route.

Self-service users see only their own data: payslips, leave requests,
timesheets, documents, profile updates. They never see other employees' pay
data, the GL, or company-wide HR reports.

## Entitlement / RBAC enforcement layers

Three independent checks must all pass before a sensitive HR/payroll action
runs. Frontend is UX only — backend is the source of truth.

```
1. Subscription entitlement     → has_app_entitlement(org, app_id)
   "Has the tenant paid for this app (in plan, trial, addon, override)?"

2. App installed                  → check_org_app_installed(org, app_id)
   "Has the tenant explicitly installed this app in the workspace?"

3. RBAC permission                → has_role / permission check
   "Does this user have the role granting this permission?"

4. Setup readiness (payroll only) → assert_payroll_ready(org)
   "Are localization, statutory rules, salary structure, GL mapping, and
    active contracts all configured?"
```

These are implemented as `SECURITY DEFINER` Postgres functions and called
from edge functions via `supabase.rpc(...)`:

- `compute-payroll`, `post-payroll-gl`, `reverse-payroll`,
  `generate-payslip-pdf`, `generate-payroll-document` all invoke
  `assert_payroll_ready` and the entitlement check helpers in
  `_shared/entitlementCheck.ts`.
- `process-leave-accruals`, `check-leave-expiry` operate against
  `time-off`-installed orgs.

## Downgrade contract

Losing entitlement to an installed app **never deletes data**. Behavior:

- **Reads** (view payslip, view leave history, export reports): remain
  available so tenants can audit historical records.
- **Writes** (run payroll, approve leave, post journal entry): blocked by
  the entitlement check; UI shows a banner directing the user to
  resubscribe or contact their admin.

This is enforced server-side. Frontend `useAppAccess` exposes a
`read_only_after_downgrade` state for banner UX.

## Dependencies — install behavior

When a user installs Payroll, the system:

1. Validates `employees` is installed (auto-installs if not — it's free).
2. Validates `finance` is installed (blocks install with explicit message
   if not — Finance is required for the GL postings).
3. Marks Payroll as installed with `lifecycle_state = 'pending_setup'`.
4. Sends the user to `/hr/payroll/statutory-rules` to complete setup.

The `ensure_app_dependencies_installed` RPC enforces this at the database
level. The frontend `InstallAppDialog` displays the dependency tree before
install so users see the full picture.

## Adding a new HR sub-app

To add e.g. Appraisals (`hr_appraisal`):

1. Define `APPRAISALS_APP` in `src/lib/apps/registry.ts` with
   `dependsOn: ["employees"]`, `internalOnly: true`, and module list.
2. Create `src/apps/hr/sub/AppraisalsRoutes.tsx` that wraps routes in
   `<HrAppShell app={APPRAISALS_APP}>` + `PermissionProtectedRoute`.
3. Add a route entry in `src/apps/hr/routes.tsx` under the appraisals path,
   wrapped in `<AppInstalledGate appId="appraisals">`.
4. Add the app to the HR Suite group in `getAppGroups()`.
5. If money/sensitive: define an `assert_appraisal_*` SQL guard and call
   it from any new edge function or RPC that mutates appraisal data.

No registry-wide refactor needed. The 5-app pattern absorbs new HR apps
without re-bundling.

## Files of record

| Concern                       | File                                              |
|-------------------------------|---------------------------------------------------|
| App definitions + dep graph   | `src/lib/apps/registry.ts`                        |
| HR URL dispatcher             | `src/apps/hr/routes.tsx`                          |
| Per-sub-app shell             | `src/apps/hr/shared/AppShell.tsx`                 |
| Install gate                  | `src/components/apps/AppInstalledGate.tsx`        |
| Cross-app entry hook          | `src/hooks/useAppEntryPath.ts`                    |
| Lifecycle action resolver     | `src/hooks/useAppLifecycle.ts`                    |
| Activate page                 | `src/pages/apps/AppActivate.tsx`                  |
| Coming-soon page              | `src/components/apps/AppUnderDevelopment.tsx`     |
| Backend entitlement helper    | `supabase/functions/_shared/entitlementCheck.ts`  |
| Payroll setup gate (UI)       | `src/components/payroll/PayrollSetupGate.tsx`     |
| Payroll setup gate (server)   | RPC `assert_payroll_ready`                        |
| Portal whitelist              | `src/components/auth/PortalUserRoute.tsx`         |
| Internal-only enforcement     | `src/components/auth/InternalOnlyRoute.tsx`       |
| Portal navigation             | `src/components/layout/PortalLayout.tsx`          |
