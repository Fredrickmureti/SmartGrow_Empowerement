# 2026-06-03 — Round-4: scope-switcher consolidation (Phase C) + branch-NULL diagnostic (Phase E)

## Phase 1 audit — evidence

Switcher entry points BEFORE Round-4:

- `ScopeBadge` (`/sales/dashboard`, Finance pages via the layout chip) — gated on `useCanSwitchScope().shouldShowTrigger`. Correct.
- `SidebarContextSwitcher` — gated on the same hook. Correct.
- `DashboardScopeSwitcher` (`/dashboard` only) — parallel dropdown with its own visibility rule, exposing "All Branches (Consolidated)" as a permission-gated option. Direct contradiction of the architecture comment in `ScopeBadge.tsx` ("delegates context switching to the existing ContextSwitcherSheet — single source of truth, no parallel switcher UI").
- `SalesDashboard.tsx:237-251` — local `<Select branchFilter>` driven by component state, separate from `BranchContext`. Two selectors on the same page.

Authorization model (verified):

- Tenant isolation: RLS by `organization_id`; `requireOrgId` query-helper gate.
- Branch isolation: app-layer (`applyBranchFilter` / `pickEffective`) + POS RPC asserts (`assert_pos_caller_branch_access`); covered by `supabase/tests/pos_branch_isolation_*`.
- Consolidated view: server-side permission `dashboard.view_consolidated` resolved by `has_dashboard_permissions` RPC inside `useDashboardScope`.
- Workspace / company switching: gated by membership in `useOrganization` / `useBusinesses`; RLS holds even if the client bypasses UI.

Verdict: **ARCHITECTURAL DEFECT (low severity)** — two switcher widgets on the dashboard, two branch selectors on the Sales dashboard. **Not a security defect** — RLS + RPC asserts hold.

## Enterprise comparison

- **Odoo** — single Companies / Branches selector in the top bar. Multi-company aggregation = picking multiple companies in the same selector.
- **NetSuite** — single Subsidiary Navigator. Consolidated rollups are a report-time choice, not a parallel switcher.
- **Microsoft Dynamics 365** — single company-switcher in the header.
- **QuickBooks Enterprise** — single Locations selector with an "All Locations" entry inside it.

Round-4 brings the platform in line: one switcher, one place, with "All Branches (Consolidated)" as an entry inside the same sheet, gated server-side.

## Fix (Phase C)

1. `ContextSwitcherSheet` now accepts optional `consolidatedAvailable`, `consolidatedActive`, `onSetConsolidated` props and renders a "Reporting view" section containing the consolidated entry when authorized. Picking a branch always clears consolidated to preserve the single-mode invariant.
2. New `useScopeSwitcherProps()` adapter returns those props from `useDashboardScope().isConsolidatedAuthorized` + `BranchContext`.
3. `ScopeBadge` passes the adapter props through, so every page that already mounts `ScopeBadge` gains the consolidated entry for free when the user is authorized.
4. `useCanSwitchScope` widened: `shouldShowTrigger` is now also true when `isConsolidatedAuthorized && branches.length >= 1`, so the only path to consolidated stays reachable on single-branch tenants.
5. `DashboardScopeSwitcher.tsx` deleted; `Dashboard.tsx` now mounts `ScopeBadge` (with `declareScope={false}` so the existing `DashboardScopeBadge` remains the authoritative declarer of the dashboard's scope label).
6. `SalesDashboard.tsx` no longer renders its own `<Select branchFilter>` — `branchId` is read directly from `BranchContext`. Single source of truth for "what branch am I looking at".

## Fix (Phase E)

1. New migration `20260603192703_branch_null_diagnostic_view.sql`:
   - View `public.branch_null_diagnostic` — UNION across the major branch-scoped tables (invoices, sales_orders, deliveries, payments, bills, journal_entries, pos_transactions, bank_accounts) filtering `branch_id IS NULL`.
   - SECURITY DEFINER wrappers `branch_null_diagnostic_counts(_organization_id)` and `branch_null_diagnostic_rows(_organization_id, _table)` — both gated by `has_role(auth.uid(), 'admin')`. RLS is enforced inside the wrapper since views cannot carry policies.
2. New admin-only page `src/pages/diagnostics/BranchNullDiagnostic.tsx` at `/settings/diagnostics/branch-null`. Read-only counts table; remediation is intentionally out of scope.

## Verified

- `useCanSwitchScope` tests — existing 5 + 1 new (consolidated-authorized single-branch case) all green.
- The scope-trigger-visibility arch test continues to pass: `ScopeBadge`, `SidebarContextSwitcher` consult `useCanSwitchScope`; `DashboardScopeSwitcher` is gone; `ContextSwitcherSheet` is allow-listed.
- Manual smoke (target): single-branch / single-company tenant on `/dashboard` and `/sales/dashboard` → no trigger unless the user holds `dashboard.view_consolidated`; multi-branch tenant → exactly one chip + one trigger on each page.

## Out of scope

- Cosmetic JSX sweep of the 13 `<FinanceScopeBadge />` call sites (separate pure-refactor pass).
- Remediation of legacy `branch_id IS NULL` rows surfaced by the diagnostic (per-tenant migration).
- No changes to RLS, roles, permissions, or RPC asserts beyond the read-only wrappers above.
## Round-5 — single-branch consolidated trigger (2026-06-03)

Phase C left one residual case: a 1-workspace / 1-company / 1-branch tenant
whose user held `dashboard.view_consolidated` still saw the "Change scope"
trigger, because `useCanSwitchScope.canSwitchToConsolidated` only required
`branches.length >= 1`. "All branches (consolidated)" over a one-branch set
is identical to that branch, so the trigger opened a no-op switcher.

Fix: raise the threshold to `branches.length >= 2`. Server-side authorization
(`has_dashboard_permissions`) and the consolidated entry inside
`ContextSwitcherSheet` are unchanged — we only stopped offering the trigger
when there is provably nothing to switch to.

Enterprise comparison (all hide the switcher on single-target tenants):

- **Odoo** — Companies selector is suppressed when the user belongs to one company / branch.
- **NetSuite** — Subsidiary Navigator only appears for multi-subsidiary accounts.
- **Microsoft Dynamics 365** — Company switcher in the header is hidden for single-company tenants.
- **QuickBooks Enterprise** — Locations selector requires ≥ 2 locations to render.

Guard: `src/test/architecture/scope-trigger-single-branch.test.ts` pins
the `>= 2` threshold against accidental regression.
