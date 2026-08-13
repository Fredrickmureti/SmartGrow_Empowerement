# Employees Navigation & Information Architecture — Audit and Remediation Plan

## Verdict up front

This is **not** a UI/cosmetic issue and **not** "no issue". It is a **workspace-architecture inconsistency**: the Employees workspace has one app identity but seven competing sidebar configurations, and five of its own nav links jump out of its nav space. Every other module in the ERP follows a strict one-app / one-nav rule. Employees is the only exception.

---

## Phase 1 — What the code actually does (verified)

Routing: `/hr/*` is a dispatcher (`src/apps/hr/routes.tsx`) that splits the URL space into lazily loaded sub-apps: `contracts/*`, `lifecycle/*`, `reports/*`, `document-compliance/*`, `recruitment/*`, `talent/*`, `leave/*`, `attendance/*`, `payroll/*`, and a catch-all for Employees.

Every sub-app mounts the **same shell** (`PlatformShell`) but supplies its own `nav`:

| Route subtree | `app` passed | `nav` passed | File |
| --- | --- | --- | --- |
| `/hr/employees/*`, `/hr/dashboard`, `/hr/configuration` | `EMPLOYEES_APP` | `EMPLOYEES_NAV` | `sub/EmployeesRoutes.tsx:55` |
| `/hr/contracts/*` | `EMPLOYEES_APP` | `CONTRACTS_NAV` | `sub/ContractsRoutes.tsx:26` |
| `/hr/lifecycle/*` | `EMPLOYEES_APP` | `LIFECYCLE_NAV` | `sub/LifecycleRoutes.tsx:27` |
| `/hr/reports/*` | `EMPLOYEES_APP` | `HR_REPORTS_NAV` | `sub/HrReportsRoutes.tsx:29` |
| `/hr/document-compliance/*` | `EMPLOYEES_APP` | `DOCUMENT_COMPLIANCE_NAV` | `sub/DocumentComplianceRoutes.tsx:21` |
| `/hr/recruitment/*` | `EMPLOYEES_APP` | `RECRUITMENT_NAV` | `sub/RecruitmentRoutes.tsx:17` |
| `/hr/leave`, `/hr/attendance`, `/hr/payroll`, `/hr/talent` | own `*_APP` | own nav | respective files |

Findings, each evidence-backed:

1. **Same layout provider, different nav payload.** `PlatformShell` wraps everything in `AppLayoutProvider appId={app.id}` (`PlatformShell.tsx`), so Contracts and Employees share one app context (`employees`). Only the `nav` prop differs. So it is *not* a different app — the sidebar merely renders a different tree.
2. **The sidebar is stateless and total.** `WorkspaceSidebar`/`SidebarBody` renders exactly `nav.groups` and nothing else. There is no notion of a parent nav, no merge, no "return to workspace" affordance. Replacing `nav` therefore replaces 100% of the sidebar.
3. **The breadcrumb is computed from `app.name` + the nav match** (`WorkspaceTopBar.useCrumbs`: `crumbs = [{ app.name, app.basePath }, ...matchedNavTrail]`). Because `app` is still `EMPLOYEES_APP`, the crumb reads `Employees > All contracts` while the sidebar shows the Contracts tree. **The breadcrumb and the sidebar disagree about where the user is** — this is the root cause of the reported dissonance, and it is a direct consequence of item 1.
4. **Recovery only exists via the breadcrumb.** `CONTRACTS_NAV`, `LIFECYCLE_NAV`, `HR_REPORTS_NAV`, `DOCUMENT_COMPLIANCE_NAV` and `RECRUITMENT_NAV` contain no link back into `/hr/employees/*`. The only way back is clicking the `Employees` crumb (which links `app.basePath`) or the app rail. That matches the reported behaviour exactly.
5. **The Employees nav deliberately links out of its own nav space.** `EMPLOYEES_NAV` group "People operations" points at `/hr/contracts/all`, `/hr/lifecycle/timeline`, `/hr/recruitment` (`shared/navs.ts`). The in-code comment says these targets are `internalOnly` apps that would otherwise be unreachable. So the nav-swap is a **side effect of a reachability patch**, not an intentional context boundary.
6. **Elsewhere in the ERP this does not happen.** Every non-HR workspace passes exactly one nav for its entire subtree (`contacts`, `crm`, `dashboard`, `finance`, `inventory`, `platform`, `hardware`, `pos`, `projects`, `purchases`, `reports`, `sales`, `sms`, `studio`, `timesheets`, `warehouse` — one `PlatformShell app=… nav=…` per module). And every one of those navs is **prefix-closed**: every `to:` in `src/apps/<m>/nav.ts` stays inside that module's own URL prefix (`/finance/*`, `/sales/*`, `/warehouse-app/*`, …). Employees is the only nav that links outside its own prefix into a subtree that then swaps the sidebar.

## Phase 2 — Is Contracts a child of Employees, or its own app?

The codebase asserts **both**, in different layers:

- **Child of Employees** — app identity (`EMPLOYEES_APP`), install gating (`AppInstalledGate appId="employees"` in `routes.tsx`), breadcrumb root, app-rail highlight, `AppLayoutProvider appId="employees"`.
- **Independent workspace** — URL space (`/hr/contracts/*`, a sibling of `/hr/employees/*`, not a descendant), its own `*Routes.tsx` bundle, and its own total sidebar.

The mixed model is therefore located precisely at: **route prefix + nav prop say "sibling app"; app definition, gating and breadcrumb say "child feature"**. Contracts has no separate installability, entitlement, permission set, or app registry entry of its own — so on every dimension that carries product meaning, it is a **feature of Employees**. Only the URL shape and the nav prop pretend otherwise.

## Phase 3 — Consistency sweep

- Finance, Sales, Purchases, Contacts, Inventory, CRM, Projects, Warehouse, Timesheets, Reports, POS, SMS, Studio, Platform, Hardware, Dashboard: one shell, one nav, prefix-closed, sub-features are **groups/children inside** the single nav (e.g. Payroll nests nine `Configuration` children under one nav item via `WorkspaceNavItem.children`). No parent-nav replacement anywhere.
- HR domain: correctly split where the split is real — Time Off, Attendance, Payroll, Talent are separately installable apps with their own `AppDefinition`, so their nav swap **is** an app switch and is legitimate.
- Inconsistencies found (complete list):
  1. `/hr/contracts/*` replaces the Employees sidebar while remaining the Employees app.
  2. `/hr/lifecycle/*` — same.
  3. `/hr/recruitment/*` — same (and its nav has exactly one item, so the swap costs the user the whole Employees tree to show one link).
  4. `/hr/reports/*` — same.
  5. `/hr/document-compliance/*` — same, and it is not reachable from `EMPLOYEES_NAV` at all, so it is a nav-orphan surface.
  6. `EMPLOYEES_NAV` is the only non-prefix-closed nav in the ERP.
  7. `ORG_NAV` still exists in `shared/navs.ts` but its routes now redirect into Employees — dead configuration that will confuse the next change.
  8. Existing guard tests (`workspace-shell.test.ts`, `hr-suite-consistency.test.ts`) enforce "each sub-app mounts PlatformShell with *its own* nav" — the guard currently **locks the inconsistency in**.

## Phase 4 — Enterprise ERP comparison, and the reasoning behind it

- **Odoo** — Contracts is a menu item *inside* the Employees app; the app's menu bar never changes while you are in Employees. Odoo's model is "app = installable module = one menu"; because Contracts is not separately installable, it cannot own a menu. This is exactly the invariant this codebase already encodes with `AppDefinition`/`AppInstalledGate` and then breaks in the nav layer.
- **SAP S/4HANA (Fiori)** — spaces/pages, then object pages. Navigating into a related object keeps the space navigation; drill-down uses the object page + related-apps links, never a navigation-panel substitution. Rationale: the launchpad's navigation panel represents *authorisation and role scope*, which does not change when you open a related object.
- **SAP SuccessFactors / Oracle Fusion HCM / Workday** — one persistent global module nav; deep HR objects (contract, job requisition, lifecycle event) open as sub-tabs or related-content panels within the person/module context. Rationale: HR work is *person-centric and cross-object* — an HR officer constantly moves employee → contract → position → letter, so the shell must be the stable frame and only the content region should change.
- **Dynamics 365** — explicit **area switcher** at the bottom of a persistent site map. When context truly changes, the product makes the switch *deliberate and visible*; groups inside an area expand instead of replacing. Rationale: implicit nav replacement destroys the user's spatial model; an explicit switcher preserves it.

The common architectural principle: **navigation replacement is reserved for crossing a bounded context (a differently-licensed, differently-authorised application). Within a bounded context, navigation expands (progressive disclosure), it never swaps.** Employees/Contracts share licence, install state, permissions and data domain — so by this principle it must expand.

## Phase 5 — User-experience impact

Workflow: `Directory → open employee → Contracts & letters → renew → back → Departments → Recruitment`.

- HR Officer (highest frequency): every hop into Contracts costs the whole Employees tree; returning requires a breadcrumb click, then re-navigating to Departments. Two extra recovery clicks per hop, several times an hour.
- HR Manager: reviews across contracts, lifecycle and recruitment in one sitting — that is three nav replacements with no lateral links between them, so all lateral movement is forced through Employees as a hub.
- Payroll Officer: enters from Payroll (a genuinely separate app), needs a contract fact, lands in a sidebar that says Contracts while the crumb says Employees — cannot tell whether they left Payroll's licence scope.
- Administrator: `document-compliance` has no nav entry anywhere, so it is effectively undiscoverable.

Concrete effects: navigation discontinuity (verified: total sidebar replacement), hierarchy loss (verified: breadcrumb/sidebar disagreement), recovery cost (verified: no back-link in the child navs), discoverability failure (verified: orphan surface). Cognitive load is a consequence of the first two, not an independent claim.

## Phase 6 — Classification

Primary: **Workspace architecture** — sub-surfaces are modelled as workspaces in the nav/route layer while being features in the app/entitlement layer.
Secondary: **Information architecture** (the same content sits at two hierarchy levels) and **navigation architecture** (the shell has no composition mechanism, only replacement).
Not a route-architecture defect: the `/hr/*` dispatcher and lazy sub-bundles are sound and worth keeping.
Not cosmetic.

## Phase 7 — Options and recommendation

**Option A — persistent Employees workspace, expandable sub-navigation.** One `EMPLOYEES_NAV` covering contracts / lifecycle / recruitment / reports / document-compliance as collapsible `children`; sub-app route bundles and URLs untouched. Pros: matches Odoo and the rest of this ERP; zero route churn; keeps lazy loading; fixes breadcrumb agreement for free (crumbs are derived from the nav that is passed). Cons: the Employees sidebar grows — mitigated by the `children` collapsible support the sidebar already has, and by the fact that Payroll already carries a larger tree.

**Option B — promote Contracts to a first-class app.** Would make the swap honest. Cons: requires a registry entry, install/entitlement/permission model, licence decision, and an app-rail slot for something that is not separately sold. Also fragments HR letters across two apps and would require the same treatment for lifecycle, recruitment, reports, document-compliance — four more pseudo-apps. Rejected: it fixes the symptom by inventing product boundaries that do not exist.

**Option C — workspace shell with a distinct secondary nav column.** Persistent Employees nav plus a second contextual column inside Contracts. Cons: a third navigation level for the whole platform, ~240px more chrome, and no other module needs it. Rejected as over-engineering.

**Option D — explicit area switcher (Dynamics style).** Keep separate navs but add a visible switcher pinned in the sidebar. Cheaper than C, but preserves the false boundary and still contradicts the breadcrumb. Rejected as a half-measure; however, its "switching must be explicit" lesson is already satisfied by the app rail for the genuine app boundaries (Payroll, Time Off, Attendance, Talent).

**Recommendation: Option A.** It aligns the nav layer with the boundary the codebase already enforces at the entitlement layer (`AppInstalledGate appId="employees"`), removes all seven inconsistencies, requires no route or data changes, and makes Employees behave like every other module in the ERP.

## Phase 8 — Implementation plan (no code changes in this plan)

### Stage 1 — Nav composition (the whole functional fix)
- In `src/apps/hr/shared/navs.ts`, restructure `EMPLOYEES_NAV` into stable groups: `Organization` (Overview, Directory, Departments, Job positions, Work locations, Org chart), `People operations` (Contracts & letters, Lifecycle events, Recruitment — each a parent item with the existing sub-links as `children`), `Insights` (HR reports with its library children), `Compliance` (Document compliance — closes the orphan), `Setup` (Configuration, unchanged).
- Keep `CONTRACTS_NAV`, `LIFECYCLE_NAV`, `HR_REPORTS_NAV`, `DOCUMENT_COMPLIANCE_NAV`, `RECRUITMENT_NAV` as the exported **child arrays** consumed by `EMPLOYEES_NAV`, so there is one source of truth per surface and no duplicated link lists.
- Change the `nav` prop only: `ContractsRoutes`, `LifecycleRoutes`, `HrReportsRoutes`, `DocumentComplianceRoutes`, `RecruitmentRoutes` pass `EMPLOYEES_NAV`. No route, guard, gate, page or data change.
- Delete the dead `ORG_NAV`.

### Stage 2 — Breadcrumb and active-state behaviour
- No `WorkspaceTopBar` change required: with one nav, `useCrumbs` yields `Employees > People operations > Contracts & letters > Drafts` automatically, because it walks the matched nav trail including `children`.
- Verify parent-item active/expand behaviour: `pathIsActive` in `WorkspaceSidebar` already recurses into `children`, and `Collapsible defaultOpen={childActive}` already auto-expands the active branch — so entering `/hr/contracts/drafts` will land with People operations expanded and the leaf highlighted.
- Add `end: true` only where a parent route would otherwise steal the highlight from its children (Overview items).

### Stage 3 — Navigation persistence and state preservation
- Sidebar collapse state is already persisted in `localStorage` (`lov:workspace-sidebar:collapsed`, `lov:app-rail:collapsed`) and survives the sub-app change because the shell is not remounted.
- Note the one real remount today: the sub-app boundary swaps a lazy component, so scroll position and page-local state reset. Stage 1 does not change that, and no shared cache is affected (React Query cache lives above the shell). Recording it here so it is not mistaken for a regression later.

### Stage 4 — Guard tests (must be updated, they currently enforce the bug)
- `src/test/architecture/hr-suite-consistency.test.ts`: change the Employees-family expectations from "each sub-app mounts its own nav" to "Contracts/Lifecycle/Recruitment/Reports/Document-compliance mount `EMPLOYEES_NAV`"; leave Time Off / Attendance / Timesheets / Payroll / Talent assertions intact (their nav swap is a genuine app switch).
- New guard: **nav/app coherence** — for every `PlatformShell` mount, assert that a given `AppDefinition` is paired with exactly one `WorkspaceNav` across the codebase. This is the invariant whose absence allowed the drift.
- New guard: **nav prefix closure** — every `to:` in a workspace nav must either stay inside that app's `basePath`, or belong to a route subtree that mounts the *same* `AppDefinition`. This permits Employees' `/hr/contracts/*` links (same app) while still catching cross-app leakage.
- New guard: **no orphan HR surfaces** — every `/hr/*` route subtree mounted under `EMPLOYEES_APP` must be reachable from `EMPLOYEES_NAV`.
- `workspace-shell.test.ts` needs no change.

### Stage 5 — Documentation
- Add an ADR under `docs/architecture/decisions/` stating the rule: *navigation replacement is permitted only when crossing an `AppDefinition`; within one app, navigation expands via `WorkspaceNavItem.children`.*
- Update `docs/design-system/audit/employees.md` with the resulting IA.

### Regression risks and mitigations
- **Deep links / bookmarks**: unaffected — no URL changes, `HR_REDIRECTS` untouched.
- **Nav item count / sidebar height**: Employees grows to roughly Payroll's size; mitigated by collapsible groups. Verify at 1338x880 and on mobile (`SidebarBody` in the Sheet, `defaultExpandAll`).
- **Permission filtering**: child items must carry the same `permission` values their current standalone navs imply, otherwise previously hidden links become visible. Audit each moved item's permission during Stage 1.
- **Active-state ambiguity**: `/hr/contracts` (Overview, `end: true`) vs `/hr/contracts/all` — confirm only one highlights.
- **Breadcrumb depth**: four crumbs on the deepest paths; confirm the topbar truncates rather than wraps at narrow widths.
- **Guard-test churn**: Stage 4 must land in the same change as Stage 1, or CI fails.

### Verification checklist
- Enter `/hr/employees`, click Contracts & letters → sidebar keeps the Employees tree with People operations expanded and Drafts/Active reachable without recovery clicks.
- Breadcrumb reads a single coherent hierarchy at every depth.
- `/hr/document-compliance/expiring` reachable from the sidebar.
- Payroll / Time Off / Attendance / Talent still swap nav (genuine app boundaries) and the app rail still highlights correctly.
- Typecheck plus the architecture test suite green.
