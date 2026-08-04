# ADR 0101 — Navigation replacement is only allowed when crossing an app boundary

- Status: accepted
- Date: 2026-08-04

## Context

The platform shell (`src/components/layout/shell/PlatformShell.tsx`) takes two
inputs: an `AppDefinition` (`app`) and a `WorkspaceNav` (`nav`). The sidebar is
stateless and total — it renders exactly `nav.groups` and nothing else — while
the breadcrumb is built from `app.name` plus the trail matched inside `nav`.

The Employees workspace had drifted: `/hr/contracts/*`, `/hr/lifecycle/*`,
`/hr/reports/*`, `/hr/document-compliance/*` and `/hr/recruitment/*` each
mounted `EMPLOYEES_APP` with their **own** nav. The consequences:

- Entering Contracts replaced 100% of the Employees sidebar.
- The breadcrumb still read `Employees > …`, so breadcrumb and sidebar
  disagreed about where the user was.
- None of the replacement navs linked back into `/hr/employees/*`, so the only
  recovery was the breadcrumb root or the app rail.
- `/hr/document-compliance/*` had no entry in any nav at all.

None of these surfaces is separately installable, licensed, or permissioned:
`/hr/*` gates them all behind `AppInstalledGate appId="employees"`. Every other
module in the ERP (finance, sales, purchases, contacts, inventory, crm,
projects, warehouse, timesheets, reports, …) passes exactly one nav for its
whole subtree, and nests sub-features as `WorkspaceNavItem.children`.

Enterprise precedent agrees. Odoo binds one menu to one installable app.
SAP Fiori keeps the space navigation while drilling into related objects.
Workday / SuccessFactors / Oracle Fusion HCM keep a persistent module nav and
open deep HR objects as sub-tabs. Dynamics 365 makes context switches explicit
via an area switcher rather than replacing the site map implicitly.

## Decision

**Navigation replacement is permitted only when crossing an `AppDefinition`.
Within one app, navigation expands.**

1. A given `AppDefinition` must be paired with exactly one `WorkspaceNav`
   across the entire codebase.
2. Sub-surfaces of an app are expressed as `WorkspaceNavItem.children` inside
   that single nav, not as a separate nav passed to `PlatformShell`.
3. A surface's link list stays in its own exported nav constant (one source of
   truth) and is folded into the owning app's nav via `flattenNavItems()`.
4. Every route subtree mounted under an app must be reachable from that app's
   nav — no routable-but-invisible surfaces.
5. Genuine app boundaries (Payroll, Time Off, Attendance, Talent, Timesheets —
   each with its own `AppDefinition` and install gate) keep their own navs; the
   app rail makes that switch explicit and visible.

## Consequences

- The Employees sidebar is now stable across contracts / lifecycle /
  recruitment / reports / document compliance; only the content region changes.
- Breadcrumbs become coherent for free, since they are derived from the same
  single nav (`Employees > People operations > Contracts & letters > Drafts`).
- The Employees nav grows; collapsible groups (already supported by
  `WorkspaceSidebar`) absorb the growth, as they already do for Payroll.
- Route architecture is unchanged: the `/hr/*` dispatcher and lazily loaded
  sub-bundles stay exactly as they were.
- Enforced by `src/test/architecture/nav-app-coherence.test.ts`.
