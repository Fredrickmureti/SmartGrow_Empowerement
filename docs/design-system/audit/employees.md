# Employees App — Design System Audit

_Status snapshot after Wave 13 (Employees app streamlining)._

| Surface | Status | File(s) |
| --- | --- | --- |
| Employees list | Done — `PageHeader` + `PageBody` | `src/pages/Employees.tsx` |
| Employee create workspace | Done — routed `RecordFormShell` | `src/pages/hr/EmployeeNewPage.tsx` |
| Employee profile | Done — `PageHeader` | `src/pages/hr/EmployeeProfile.tsx` |
| Employee edit | In-place tabbed dialog (retained) | `src/components/employees/EmployeeFormDialog.tsx` |
| Departments list | Done — `PageHeader` + `PageBody` | `src/pages/Departments.tsx` |
| Department create workspace | Done — routed `RecordFormShell` | `src/features/hr/departments/DepartmentCreatePage.tsx` |
| Department edit workspace | Done — routed `RecordFormShell` | `src/features/hr/departments/DepartmentEditPage.tsx` |
| Department detail sheet | Retained (peek utility) | `src/components/departments/DepartmentDetailSheet.tsx` |
| Job Positions list | Done — `PageHeader` + `PageBody` | `src/pages/hr/JobPositions.tsx` |
| Job Position create workspace | Done — routed `RecordFormShell` | `src/features/hr/positions/JobPositionCreatePage.tsx` |
| Job Position edit workspace | Done — routed `RecordFormShell` | `src/features/hr/positions/JobPositionEditPage.tsx` |
| Work Locations list | Done — `PageHeader` + `PageBody` | `src/pages/hr/WorkLocations.tsx` |
| Work Location create workspace | Done — routed `RecordFormShell` | `src/features/hr/locations/WorkLocationCreatePage.tsx` |
| Work Location edit workspace | Done — routed `RecordFormShell` | `src/features/hr/locations/WorkLocationEditPage.tsx` |
| Configuration sub-pages | Done — `ConfigPageHeader` now wraps `PageHeader` | `src/pages/hr/configuration/_ConfigShell.tsx` |
| Delete / dissolve / archive confirm | Done (`ConfirmDeleteDialog`) | `src/components/shared/ConfirmDeleteDialog.tsx` |

## Notes

- Wave 13 retired the narrow `<Dialog sm:max-w-[500px]>` in Departments and
  the `WorkflowSheet` side drawers in Job Positions and Work Locations,
  replacing them with routed `RecordFormShell` create/edit pages under
  `/hr/employees/{departments,positions,locations}/{new,:id/edit}`. This
  matches the pattern established by HR/Payroll, Finance (accounts,
  journal entries), and Contacts.
- Legacy deep links on Departments (`?action=create[&type=]`,
  `?action=edit&id=`) redirect transparently to the new routes so
  cross-module CTAs continue to work.
- The Employees list retains its in-place `EmployeeFormDialog` for the
  "Quick add (modal)" affordance and for row-level edit; the primary
  "Add Employee" button already routes to the full-page create workspace.
  Migrating the edit path to a dedicated `/:id/edit` route is queued for
  a follow-up wave.
- `ConfigPageHeader` now wraps the design-system `PageHeader` primitive
  rather than the legacy `page-header` div, so every HR configuration
  sub-page inherits the same header treatment without touching each
  sub-page's body.
- Remaining `*Dialog` files under `src/components/employees/` (link,
  invite, manager, transfer, compensation, termination, bulk-assign) are
  workflow/confirm utilities operating on ≤6 fields or on collections —
  they are outside the record-form ban.

## Navigation IA (Wave 14 — ADR 0101)

The Employees workspace now renders **one** sidebar for its entire route
space. Contracts, Lifecycle, Recruitment, HR Reports and Document
compliance no longer replace `EMPLOYEES_NAV`; they expand inside it as
collapsible children, so the sidebar and the breadcrumb finally agree.

```text
Employees (EMPLOYEES_APP / EMPLOYEES_NAV)
  Organization
    Overview · Directory · Departments · Job positions · Work locations · Org chart
  People operations
    Contracts & letters   -> /hr/contracts/*         (CONTRACTS_NAV children)
    Lifecycle events      -> /hr/lifecycle/*         (LIFECYCLE_NAV children)
    Recruitment & offers  -> /hr/recruitment
  Insights
    HR reports            -> /hr/reports/*           (HR_REPORTS_NAV children)
  Compliance
    Document compliance   -> /hr/document-compliance/* (was a nav orphan)
  Setup
    Configuration         -> /hr/configuration/*
```

Rules now enforced by `src/test/architecture/nav-app-coherence.test.ts`:

- one `AppDefinition` is paired with exactly one `WorkspaceNav`;
- every `EMPLOYEES_APP` route subtree is reachable from `EMPLOYEES_NAV`;
- the retired `ORG_NAV` stays deleted.

Genuine app boundaries (Payroll, Time Off, Attendance, Talent, Timesheets)
keep their own navs — that switch is a real app switch and is made explicit
by the app rail.
