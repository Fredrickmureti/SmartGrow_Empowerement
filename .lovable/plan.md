
# ESS Portal — Design System Consistency Audit & Remediation

## What I inspected

- Shell: `src/apps/me/MeApp.tsx`, `src/components/me/MePortalLayout.tsx`, `src/components/me/MeSubNav.tsx`, `src/components/me/EmployeeLinkRequired.tsx`.
- All 28 pages under `src/pages/me/` (~4,800 LOC).
- Compared against platform patterns already in production: `src/design-system/primitives/*` (PageHeader, PageBody, EmptyState, FilterBar, Section, DetailSheet, RecordFormShell, StatusBadge, LoadingState, ErrorState), `src/components/hr/` (KpiStrip, ManagerTriageBanner, SavedViewMenu, StatusFilterChips), and reference pages: `TimesheetApprovals`, `EmployeeProfile`, `Employees`, `Departments`, HR documents/contracts/lifecycle.
- Audit doc source of truth: `docs/design-system/audit/employees.md`.

## Findings — the ESS portal is materially drifted

### 1. Zero design-system primitive adoption (highest-impact drift)
- `rg -l "@/design-system/primitives" src/pages/me` → **0 files**.
- Every `/me/*` page hand-rolls `<h1 className="text-2xl font-bold tracking-tight">…</h1>` + subtitle instead of `<PageHeader>` / `<PageBody>`. Meanwhile Employees, Departments, Job Positions, Work Locations, Timesheets, HR Docs, Contracts, Lifecycle, Payroll reports have all migrated (see audit doc).
- No page uses `EmptyState`, `LoadingState`, `ErrorState`, `Section`, `FilterBar`, or `StatusBadge` primitives — each page inlines its own `<Skeleton>` grid, its own "no data" card, and its own colored `<Badge>` map.

### 2. Bespoke chrome instead of the shadcn Sidebar pattern
- `MePortalLayout` hand-rolls a `<header>` + `<aside w-60>` + mobile `<Sheet>`. The rest of the platform standardises on `SidebarProvider` / `Sidebar` / `SidebarTrigger` (see the sidebar knowledge in project rules). Result: different collapse behaviour, no icon-collapsed mini-rail, no active-state semantics from the Sidebar primitive.

### 3. Duplicated navigation surface inside the portal
- `MePortalLayout` renders a 14-item left rail **and** `MeSubNav` renders a horizontal grouped sub-nav on the same page. The rest of the platform uses one primary rail + one contextual sub-nav (`AttendanceSubNav`, `LeaveSubNav`, `TimesheetsSubNav`, `EmployeesSubNav`) — never both listing the same destinations.

### 4. Legacy dialogs where the platform moved to routed sheets/pages
- Dialog imports found in `MyShifts.tsx`, `MyLearningPage.tsx`, `MyOneOnOnes.tsx`; inline "showRequestForm" popovers in `MyLeave.tsx`.
- Platform standard for record create/edit is `RecordFormShell` routed pages (see `EmployeeNewPage`, `DepartmentCreatePage`, `WorkLocationEditPage`, etc.). Detail peeks use `DetailSheet`. ESS uses neither.

### 5. Status badges reinvented per page
- Each of `MyLeave`, `MyPayslips`, `MyDocuments`, `MyShifts`, `MyLoans` defines a local `statusBadge`/`StatusBadge` function with its own colour map. Primitive `StatusBadge` exists and is used elsewhere.

### 6. KPI band inconsistency
- `KpiStrip` is the platform's approved-count / pending-count strip (used in `TimesheetApprovals`, attendance & leave approvals). ESS ignores it — `MyLeave` hand-rolls balance cards, `MyPayslips` has no summary, `MeHome` uses custom tiles.

### 7. Header action zoning
- No page uses the `PageHeader` `actions` slot. Buttons float in ad-hoc flex rows (`MyLeave` right-aligned button; `MyPayslips` `ReportExportButtons` mid-body). Export/print/history affordances are missing on pages where they belong (`MyPayslips` has export; `MyLoans`/`MyDocuments` don't).

### 8. Loading/empty/error states are one-off per page
- `Skeleton` blocks are copy-pasted; empty states range from a plain `<Card>` sentence to nothing at all. `EmployeeLinkRequired` is the one shared empty state and is correctly reused — that's the pattern to extend everywhere.

### 9. Sub-app registration
- `MeApp` is not registered as an app under `src/apps` in the way `Contacts`/`CRM`/`Finance` are (they export `App` + `Layout`). Not user-visible, but confirms the portal predates the current app-shell convention.

## Remediation plan

### Wave A — Shell parity (foundation)
1. Rebuild `MePortalLayout` on `SidebarProvider` + `Sidebar` (shadcn) with `collapsible="icon"` so the rail collapses to icons like every other app.
2. Delete the horizontal `MeSubNav` — the rail is the single nav surface, matching every other app. Remove imports from `MePortalLayout`.
3. Keep the "Back to workspace" affordance for internal users; keep `NotificationBell`, `ThemeToggle`, user menu.
4. Ensure the shell wraps main content in `PageBody` sizing so all pages inherit consistent gutters.

### Wave B — Primitive adoption across all 28 pages
For every `/me/*` page, replace:
- Hand-rolled header block → `<PageHeader title=… subtitle=… actions={…} />`.
- Body wrapper → `<PageBody>`.
- Loading blocks → `<LoadingState />` (skeleton preset).
- Empty blocks → `<EmptyState />` (or `EmployeeLinkRequired` when applicable).
- Error blocks → `<ErrorState />`.
- Per-page filter rows → `<FilterBar />` with `SavedViewMenu` / `StatusFilterChips` where a list has status.
- Local `statusBadge` helpers → shared `<StatusBadge />` primitive with a single semantic status map contributed to `src/design-system/primitives/StatusBadge.tsx` (or a small `hr-status-map.ts` alongside it if it doesn't already exist).

Priority order (largest surfaces first):
1. `MeHome`, `MyLeave`, `MyPayslips`, `MyAttendance`, `MyTimesheets`, `MyLoans`, `MyDocuments`, `MyShifts`.
2. `MyOnboarding`, `MyExitClearance`, `MyTaxCertificates`, `MySettings`.
3. Talent cluster: `MyTalent`, `MyGoals`, `MyGoalDetail`, `MyReviews`, `MyReviewDetail`, `MyCompetencies`, `MyDevelopmentPlan`, `MyOneOnOnes`, `MyOneOnOneDetail`, `MyFeedback`.
4. Learning cluster: `MyLearningPage`, `MyLearningCatalog`, `MyLearningPathsPage`, `MyQuizPlayerPage`.
5. Team cluster: `MyTeamPage`, `MyTeamTalent`, `MyTeamLearningPage`.

### Wave C — Interaction pattern parity
1. `MyLeave` request form: convert the inline `showRequestForm` state into a routed page `/me/leave/new` backed by `RecordFormShell`, mirroring how HR creates records elsewhere. Keep the confirm/cancel affordances the shell provides; discard the local dialog.
2. `MyShifts`, `MyLearningPage`, `MyOneOnOnes` dialog imports: audit each — pure confirms stay as `AlertDialog`; record-shaped forms become routed `RecordFormShell` pages; detail peeks use `DetailSheet`.
3. Add KPI band to list surfaces: `KpiStrip` on `MyLeave` (balance / pending / used / accruing), `MyTimesheets` (this-week hours / pending / approved / rejected), `MyLoans` (outstanding / next installment / paid), `MyPayslips` (YTD gross / net / tax / last pay).
4. Standardise export/print affordances via `ReportExportButtons` in `PageHeader.actions` on `MyPayslips`, `MyTaxCertificates`, `MyLoans`, `MyDocuments`, `MyAttendance`, `MyTimesheets`.
5. Adopt `ManagerTriageBanner` uniformly on any /me page that already has a manager-facing counterpart (already present on `MyLeave`; add to `MyTimesheets` and `MyAttendance` where the user is also a manager).

### Wave D — Guardrails so drift can't return
1. New ESLint rule `eslint-rules/no-hand-rolled-me-header.js` — flags `<h1 className*="text-2xl font-bold tracking-tight">` inside `src/pages/me/` (must use `PageHeader`).
2. Architecture test `src/test/architecture/me-uses-design-system.test.ts` — asserts every `src/pages/me/*.tsx` imports at least `PageHeader` from `@/design-system/primitives`.
3. Extend `docs/design-system/audit/` with `docs/design-system/audit/ess-portal.md` mirroring the Employees audit table (row per surface, status column).

### Out of scope
- Business logic in the /me hooks (`useMyDocuments`, `useLeaveRequests`, etc.) — reads/writes unchanged.
- Talent/Learning feature surface — only their presentation.
- Router migration (react-router-dom → TanStack Router) — the whole app is on react-router-dom today; migrating just /me would break parity, not restore it.
- Notifications wiring, entitlement gating logic, session/auth flows — behaviour is correct today.

## Technical notes

- `MeApp.tsx` uses `react-router-dom` `Routes/Route`; keep it. The Sidebar rebuild lives in `MePortalLayout` only.
- `SidebarProvider` requires the outer `<div>` to be `w-full` (already covered by our shell rules).
- Shared status map: add `src/design-system/primitives/status-maps/hr.ts` if not present, so leave/payslip/loan/document statuses share one source. Reuse in admin HR pages as well to close a latent duplication there.
- Routed forms replacing dialogs: register redirects for any deep link that today opens the dialog (e.g. `?action=new`) so bookmarks and cross-links keep working — mirror the pattern used in Wave 13 for Departments.

## Verification

1. `rg -l "@/design-system/primitives/PageHeader" src/pages/me` returns all 28 pages.
2. `rg "text-2xl font-bold tracking-tight" src/pages/me` returns 0 matches.
3. `rg -l "@/components/ui/dialog" src/pages/me` returns only pages where a plain confirm dialog is genuinely needed (documented allowlist).
4. New arch test passes; new ESLint rule flags no violations.
5. Manual walk-through: navigating between `/hr/*` (admin) and `/me/*` (portal) shows identical page-header treatment, identical sub-nav treatment, identical empty/loading/error states, identical status badge palette, identical record-create ergonomics.

Estimated size: ~28 page refactors + 1 shell rewrite + 1 sub-nav deletion + 1 ESLint rule + 1 arch test + 1 audit doc. Each page refactor is presentation-only and small (<40 LOC per file on average).
