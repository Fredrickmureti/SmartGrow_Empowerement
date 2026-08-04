---
name: Workspace navigation — replacement vs expansion (ADR 0101)
description: Rule that a WorkspaceNav may only be swapped when crossing an AppDefinition; Employees folds contracts/lifecycle/recruitment/reports/document-compliance in as children.
type: feature
---

# ADR 0101 — nav replacement only across app boundaries

`PlatformShell` takes `app` (AppDefinition) + `nav` (WorkspaceNav). The sidebar
is total (renders exactly `nav.groups`) and breadcrumbs are `app.name` + the
trail matched inside `nav`. So swapping `nav` while keeping `app` produces a
sidebar/breadcrumb contradiction with no recovery affordance.

Rules (enforced by `src/test/architecture/nav-app-coherence.test.ts`):

1. One `AppDefinition` ↔ exactly one `WorkspaceNav`, codebase-wide.
2. Sub-surfaces of an app are `WorkspaceNavItem.children`, never a second nav.
3. Each surface keeps its own exported nav constant as the single source of
   truth for its links; the owning app folds it in via `flattenNavItems()`
   in `src/apps/hr/shared/navs.ts`.
4. Every route subtree mounted under an app must be reachable from its nav.
5. Real app boundaries (Payroll, Time Off, Attendance, Talent, Timesheets)
   keep their own navs — the app rail makes that switch explicit.

## Employees resolution (Wave 14)

`/hr/contracts`, `/hr/lifecycle`, `/hr/recruitment`, `/hr/reports`,
`/hr/document-compliance` all mount `EMPLOYEES_APP` and now also mount
`EMPLOYEES_NAV`. Groups: Organization / People operations / Insights /
Compliance / Setup. `ORG_NAV` deleted (dead). `/hr/*` dispatcher, URLs and
lazy sub-bundles unchanged.

`src/apps/hr/routes.tsx` is exempt in `workspace-shell.test.ts` — it is a
dispatcher owning no chrome; the `sub/*Routes.tsx` files own the shells.
