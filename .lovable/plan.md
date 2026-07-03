## Why

The Employees app currently ships **three** different form patterns and **two** different page-header patterns. The user's callout ("departments seems to have the ups") is Departments being the loudest outlier — a 500 px `<Dialog>` with `page-header` div chrome — while Employees itself has already moved onto `RecordFormShell` + `PageHeader`. Result: users see three visual languages inside a single app.

Current state (verified in code):

| Surface | Header | Create/Edit form | Standard? |
| --- | --- | --- | --- |
| `/hr/employees` list | `PageHeader` (new) | routed `EmployeeNewPage` → `RecordFormShell` | ✅ |
| `/hr/employees` edit | `PageHeader` | inline `<Dialog>` via `EmployeeDirectoryDialogs` | ❌ |
| `/hr/employees/departments` | legacy `page-header` div | narrow `<Dialog sm:max-w-[500px]>` | ❌ (worst) |
| `/hr/employees/positions` | legacy `page-header` div | `WorkflowSheet` side drawer | ⚠️ |
| `/hr/employees/locations` | legacy `page-header` div | `WorkflowSheet` side drawer | ⚠️ |
| `/hr/employees/org-chart` | legacy `page-header` | n/a | ⚠️ |
| `/hr/configuration/*` | `ConfigPageHeader` (bespoke) | mixed Dialog / WorkflowSheet | ⚠️ |

Standard for this ERP (established by HR/Payroll and enforced across Finance, Sales, Purchases, Contacts): substantial business records go to routed `RecordFormShell` at `/<entity>/new` and `/<entity>/:id/edit`; list/page chrome uses `PageHeader` + `PageBody` + `Section`; confirm/utility flows remain small dialogs.

## Scope (Employees app only, this pass)

Sales / Purchases / Inventory / Finance / other HR workspaces (Attendance, Payroll, Talent, Contracts, Reports) are out of scope for this turn — they are separate waves in the platform initiative.

## Changes

### 1. Departments → routed `RecordFormShell`

- New `src/features/hr/departments/DepartmentRecordForm.tsx` — shared body (identity, parent, manager, description) using `Section` + `FieldGrid`.
- New `src/features/hr/departments/DepartmentCreatePage.tsx` and `DepartmentEditPage.tsx` mounted on `RecordFormShell` (mirrors `ContactCreatePage` / `AccountCreatePage`).
- Routes added under `EmployeesRoutes`:
  - `employees/departments/new` → create
  - `employees/departments/:id/edit` → edit
- `src/pages/Departments.tsx`:
  - delete the ~110-line inline `<Dialog>` (imports, state, JSX, handlers).
  - `handleOpenDialog(dept?)` becomes `navigate(dept ? `.../${dept.id}/edit` : `.../new`)`.
  - swap the `<div className="page-header">` block for `<PageHeader>` (matches Employees list).
  - keep `ConfirmDeleteDialog` and `DepartmentDetailSheet` — they are confirm/peek utilities, in-spec.
  - accept legacy `?action=create|edit&id=` query as a redirect for one release (same pattern used by `Contacts.tsx` after Wave 12).

### 2. Job Positions & Work Locations → routed `RecordFormShell`

Both are substantive records (name, code, org placement, address, headcount, description) — they belong in the routed record pattern, not a side drawer. WorkflowSheet is retained for genuinely lightweight workflow steps elsewhere in the app; these two are not that.

- `src/features/hr/positions/{JobPositionRecordForm,JobPositionCreatePage,JobPositionEditPage}.tsx`
- `src/features/hr/locations/{WorkLocationRecordForm,WorkLocationCreatePage,WorkLocationEditPage}.tsx`
- Routes: `employees/positions/new`, `employees/positions/:id/edit`, `employees/locations/new`, `employees/locations/:id/edit`.
- `JobPositions.tsx` / `WorkLocations.tsx`:
  - swap `WorkflowSheet` + inline state for `navigate(...)`.
  - swap legacy `page-header` for `<PageHeader>`.

### 3. Employees list — retire the edit `<Dialog>`

- `handleOpenDialog(emp)` (edit path) navigates to `/hr/employees/:id/edit` instead of opening `EmployeeDirectoryDialogs`'s form dialog.
- Introduce `src/pages/hr/EmployeeEditPage.tsx` (thin wrapper reusing `EmployeeFormDialog renderAs="page" hideInlineForm hideInlineFooter` inside `RecordFormShell mode="edit"`, matching the plumbing the previous agent added for `EmployeeNewPage`).
- Add route `employees/:id/edit` in `EmployeesRoutes` (must be declared **before** `employees/:id` so it doesn't get captured by the profile route).
- `EmployeeDirectoryDialogs` keeps its non-form dialogs (invite, link, set-manager, bulk assign) — those are workflow utilities, in-spec.

### 4. Configuration header consistency

- `src/pages/hr/configuration/_ConfigShell.tsx`: rewrite `ConfigPageHeader` as a thin wrapper around `PageHeader` that adds the "← Configuration" eyebrow. All config sub-pages continue to import the same component; no per-page changes required. This aligns config chrome with the rest of the app without touching each sub-page's body.

### 5. Ledger

- New `docs/design-system/audit/employees.md` documenting the final surface map (matches the format of `contacts.md`).

## Explicitly NOT changing

- Underlying save RPCs, permissions (`manageEmployees`), data loaders, drafts, or delete/confirm dialogs.
- `EmployeeFormDialog` internal contents — only the two opt-in props already added (`hideInlineForm`, `hideInlineFooter`) are reused.
- Org Chart page (no record form — layout-only), Attendance, Payroll, Talent, Contracts, HR Reports.
- Table/list ergonomics inside the pages (columns, filters, empty states) — those are already using the shared primitives.

## Verification

- Playwright: screenshot `/hr/employees/new`, `/hr/employees/:id/edit`, `/hr/employees/departments/new`, `/hr/employees/positions/new`, `/hr/employees/locations/new` — headers/footers should be visually identical (eyebrow + title, sticky footer with Cancel left / primary right).
- `rg "sm:max-w-\[500px\]" src/pages/Departments.tsx` returns nothing.
- `rg "WorkflowSheet" src/pages/hr/{JobPositions,WorkLocations}.tsx` returns nothing.
- Legacy deep links (`/hr/employees` "Add employee" and per-row "Edit") still land on the right routed page.
- Typecheck + build pass (harness runs them automatically).

## Files touched

Created:
- `src/features/hr/departments/{DepartmentRecordForm,DepartmentCreatePage,DepartmentEditPage}.tsx`
- `src/features/hr/positions/{JobPositionRecordForm,JobPositionCreatePage,JobPositionEditPage}.tsx`
- `src/features/hr/locations/{WorkLocationRecordForm,WorkLocationCreatePage,WorkLocationEditPage}.tsx`
- `src/pages/hr/EmployeeEditPage.tsx`
- `docs/design-system/audit/employees.md`

Modified:
- `src/pages/Departments.tsx` — drop inline Dialog, swap page header, navigate to routed pages.
- `src/pages/hr/JobPositions.tsx` — drop WorkflowSheet, swap page header, navigate to routed pages.
- `src/pages/hr/WorkLocations.tsx` — same.
- `src/pages/Employees.tsx` — edit path navigates to `/hr/employees/:id/edit`; `EmployeeDirectoryDialogs` no longer receives form-dialog props.
- `src/components/employees/directory/EmployeeDirectoryDialogs.tsx` — remove the form-dialog branch (workflow dialogs remain).
- `src/apps/hr/sub/EmployeesRoutes.tsx` — add the 7 new routes (in the correct order relative to `employees/:id`).
- `src/pages/hr/configuration/_ConfigShell.tsx` — reimplement on top of `PageHeader`.
