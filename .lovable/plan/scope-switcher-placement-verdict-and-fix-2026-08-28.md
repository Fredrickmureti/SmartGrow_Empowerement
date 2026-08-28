# Scope switcher placement — verdict and fix

## Verdict: your concern is valid

I checked the actual chrome rather than assuming.

- The only real scope-switch triggers today are:
  - `SidebarContextSwitcher`, mounted **only** in the legacy `AppSidebar`
  - a duplicate trigger inside `AppAwareSidebar`
  - per-page `ScopeBadge` / `FinanceScopeBadge` / `DashboardScopeBadge`, hand-placed on Dashboard, Banking, Accounts, Journals, Budgets, AR/AP and a handful of finance pages
- The **new** shell (`PlatformShell` = app rail + `WorkspaceSidebar` + `WorkspaceTopBar`) that Reports and the migrated apps use has **no switcher at all**. Its `DeclaredScopeChip` in the topbar is deliberately read-only, and it renders *nothing* unless the page happens to call `useDeclareScope`.

So on `/reports/*` there is genuinely no way to change company/branch — you must navigate back to a page that still carries a legacy badge. That is a real gap, not a perception issue.

One thing you are (reasonably) wrong about: this should **not** be admin-gated.

## Where it belongs — and why not the profile menu

Keep identity and scope separate. Every mature ERP does:

| Product | Scope switcher location |
| --- | --- |
| Odoo | Company selector in the top systray, left of the user avatar |
| NetSuite | Role/subsidiary switcher in the header bar, separate from the user menu |
| Dynamics 365 BC | Company picker in the top-right header |
| Xero / QuickBooks | Organisation switcher top-left, next to the product name |

None of them bury it in the profile/avatar menu: the profile answers "who am I", the scope answers "which books am I looking at". Merging them makes scope changes feel personal and reversible when they are actually a data-context change that repaints every figure on screen.

**Placement decision:** the persistent slot already reserved for it — the scope chip in `WorkspaceTopBar`, immediately after the breadcrumb, left of the right-hand action cluster. It is visible on every page of every migrated app, sits next to the breadcrumb that says *where* you are (so it reads "where + whose books"), and it already exists as a read-only chip, so this is promotion, not a new UI element.

## Who should see it — the correct gate

Not "admins only". Scope switching is a **membership** question, not a privilege question: you can only ever switch to a workspace / company / branch you have already been granted. Restricting the switcher to admins would trap a branch-manager with two branches, while an admin with one company would see a switcher that does nothing.

The existing `useCanSwitchScope` rule is already the right one and stays unchanged:

- show when there are ≥ 2 workspaces, or ≥ 2 companies, or ≥ 2 branches, or the user is server-authorised for consolidated **and** has ≥ 2 branches
- hide otherwise (single-target tenants see only the read-only chip)
- creating a company/branch stays in Settings, never in the switcher

The lists inside `ContextSwitcherSheet` come from `useOrganization` / `useBusinesses` / `useBranch`, which are RLS-scoped, and consolidated access is already server-checked via `dashboard.view_consolidated`. So the affordance is safe by construction — no new permission is needed, and adding an admin-only gate would be a regression.

## What to build

1. **Make the topbar chip the canonical trigger.** New `ScopeSwitcherChip` (in `src/components/common/`) that:
   - shows `Company · Branch · CUR`, falling back to live `BusinessContext` / `BranchContext` values when no page declared a scope, so it is never blank inside `PlatformShell`
   - still prefers a page-declared scope (`useDeclaredScope`) when present, so consolidated / executive views keep their own label
   - when `useCanSwitchScope().shouldShowTrigger` is true, renders as a button (chevron affordance, `aria-label="Change scope"`) opening `ContextSwitcherSheet` with `useScopeSwitcherProps()`; otherwise renders exactly today's static badge
2. **Mount it in `WorkspaceTopBar`** in place of `DeclaredScopeChip`. This alone gives Reports and every migrated app a switcher on every page.
3. **Mobile:** the topbar chip is currently `hidden md:inline-flex`. Show a compact icon-only variant below `md` so small screens are not left without the affordance.
4. **Remove the duplicate trigger risk.** Pages inside `PlatformShell` that render their own "Change scope" button (`ScopeBadge`, `FinanceScopeBadge`) would now show two triggers. Keep the per-page badges as scope *declarations* but drop their inline "Change scope" button when they are inside an app layout (`useAppLayout().isInsideAppLayout`), so exactly one trigger exists per screen. Standalone/legacy pages are unaffected.
5. **Leave the legacy sidebars alone.** `AppSidebar` / `AppAwareSidebar` keep `SidebarContextSwitcher` — those shells have no `WorkspaceTopBar`, so removing it there would recreate the gap.

## Technical notes

- No changes to `useCanSwitchScope`, `ContextSwitcherSheet`, or any permission/RLS logic — presentation and placement only.
- `src/test/architecture/scope-trigger-visibility.test.ts` requires any component mounting `ContextSwitcherSheet` to gate on `useCanSwitchScope()`; `ScopeSwitcherChip` satisfies that directly.
- `scope-trigger-single-branch.test.ts` pins the `branches.length >= 2` consolidated threshold; untouched.
- New guard test: `WorkspaceTopBar` must render `ScopeSwitcherChip`, so a future refactor cannot silently strip the switcher out of the platform shell again.
- Verify with a Playwright pass on `/reports/*` and one finance page: switcher present on both, exactly one trigger per screen.
