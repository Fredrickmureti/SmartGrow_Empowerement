# 2026-06-03 — Scope trigger visibility on single-target tenants

## Finding
`useCanSwitchScope` returned `shouldShowTrigger = hasAlternatives || canCreateAny`. For an admin of a fresh single-branch / single-company tenant, `canCreateAny=true` flipped the trigger on, so the "Change scope" button rendered next to `ScopeBadge` even though there was nothing to switch *to*. The sheet's only meaningful action in that state was "Create company / workspace" — i.e. the affordance was mislabelled.

Classification: **UX ISSUE + minor ARCHITECTURAL DEFECT**. Not a security issue — RLS + `user_can_access_business` still gate the data.

## Enterprise comparison
- **Odoo, NetSuite, Microsoft Dynamics 365, QuickBooks Enterprise:** company/branch switcher is hidden entirely on single-target tenants. "Add company / branch" lives in Settings.
- **SAP, Oracle:** same pattern — entity selector is conditional on ≥2 entities the user can access.

## Fix
`shouldShowTrigger` now tracks `hasAlternatives` only. A new `shouldShowCreateHint` (true only when the trigger is hidden AND the user can create) is exposed for callers that want a quiet "Add…" CTA; default behaviour is to leave creation to Settings. No other surface needed to change — `ScopeBadge`, `SidebarContextSwitcher`, `DashboardScopeSwitcher` already consume `shouldShowTrigger`.

## Verified
- `src/test/hooks/useCanSwitchScope.test.tsx` — 5/5 green (single-target admin, single-target user, multi-branch, multi-company, multi-workspace).
- `src/test/architecture/scope-trigger-visibility.test.ts` — still green.

## Out of scope
- Round-2 Phases B-sweep / C / E remain queued.
- No RLS, role, or permission changes.
