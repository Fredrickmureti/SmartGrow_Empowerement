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
