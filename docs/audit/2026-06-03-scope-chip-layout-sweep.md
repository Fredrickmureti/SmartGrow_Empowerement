# 2026-06-03 — Phase B-sweep: layout-owned scope chip

## Finding (post Round-3)

After the trigger-visibility fix, `FinanceScopeBadge` had two responsibilities:

1. Declare the active finance scope to the layout via `useDeclareScope`.
2. Render an inline `<Badge>` in every Finance page header.

The companion `<DeclaredScopeChip />` was built to host (2) once in the app header, but no layout had mounted it yet, so the inline badge was still the only visible surface — and 13 pages duplicated header chrome. On a multi-branch tenant that would have produced two chips side by side as soon as the layout slot landed.

Classification: **UX ISSUE + minor ARCHITECTURAL DEFECT** (two sources of truth for one piece of header chrome).

## Enterprise comparison

- **Odoo, NetSuite, Microsoft Dynamics 365, SAP, QuickBooks Enterprise:** the active company / branch chip lives in the global app header next to the user menu — never re-drawn inside each module's page. Module pages declare what they're scoped to (often implicitly via the route) and the chrome reads that declaration.

## Fix

- `AppTopNavbar` now mounts `<DeclaredScopeChip />` in the right-side action cluster. It renders `null` until a page declares a scope, so non-Finance apps are unaffected today and Sales/Inventory/HR will pick it up for free as they adopt `useDeclareScope`.
- `FinanceScopeBadge` is now a render-null declaration shim — it still calls `useDeclareScope` (the layout chip is fed unchanged) but draws nothing inline. New code should call the exported `useDeclareFinanceScope()` hook directly.

### Why not delete the 13 inline JSX call sites?

The shim collapses page-side responsibility to "declare, don't draw" with zero risk to the 10 architecture tests that grep for `FinanceScopeBadge` and zero churn at call sites. A future cosmetic sweep can swap each `<FinanceScopeBadge />` JSX for `useDeclareFinanceScope()` calls, but it is a pure-refactor concern — the behavior contract is already correct.

## Verified

- `useCanSwitchScope` 5/5 still green.
- Manual trace: on a single-branch tenant `useFinanceScope().hasMultipleBranches === false` → declaration is `null` → `DeclaredScopeChip` renders `null` → header is clean. On a multi-branch tenant exactly one chip renders in the navbar.

## Out of scope (queued)

- Phase C — fold `DashboardScopeSwitcher` into `ContextSwitcherSheet`.
- Phase E — branch-NULL diagnostic on branch-scoped tables.
- Cosmetic JSX cleanup of the 13 `<FinanceScopeBadge />` call sites.
