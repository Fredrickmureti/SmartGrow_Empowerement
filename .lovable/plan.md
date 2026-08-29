# Smart Grow Empowerment — Microfinance Convergence (living status)

Approved roadmap archive:
`.lovable/plan/smart-grow-empowerment-microfinance-convergence-reworked-pla-2026-08-29.md`

## Verified baseline (Phase 0)
- 843 tables, 3,083 functions, 2,082 policies; 1 org / 1 business / 1 branch /
  101 accounts / 1 auth user.
- No microfinance domain exists in code or schema. "Loan" tables are payroll
  employee-advance artifacts.
- Routing is the legacy React Router SPA (`src/App.tsx`) mounted through the
  TanStack catch-all `src/routes/$.tsx`.

## M3 — De-SaaS the application shell (IN PROGRESS)

Done in this pass (code only, no schema change yet):
- Platform-admin console removed: `src/pages/admin/**`, `src/components/admin/**`,
  `src/apps/platform-admin/**`, `AdminManagement`, `AdminProtectedRoute`,
  `AdminAuthOnlyRoute`, all `/admin-management/*` routes and lazy exports.
- Platform-admin persona collapsed: `PlatformIdentityContext` is now a constant
  ("never an admin"); admin branches removed from `ProtectedRoute`, `Dashboard`,
  `OnboardingSetup`, `SignupForm`, `AppSidebar`, `postLoginRedirect`,
  `flowRouter`, `signOutAndRedirect`.
- Billing / marketplace removed: `/upgrade`, `/billing`, `/apps`,
  `/apps/:id/activate`, `/apps/setup`, `/settings/apps`, `/select-organization`
  routes plus their pages.
- Entitlement gating collapsed for a single institution:
  - new `src/components/auth/InstitutionRoute.tsx` (auth + portal boundary +
    workspace readiness only); `SubscriptionProtectedRoute` is now a deprecated
    alias of it,
  - `SubscriptionGate` / `SubscriptionFeatureCheck` / `AppInstalledGate` are
    pass-throughs,
  - subscription banners, blocked page, upgrade modal, usage widget removed.

Gate: `/`, `/login`, `/dashboard` all return 200 (a stale Vite dep cache had to
be cleared again — same failure documented for M1r).

### M3 remaining
- Migrate the ~10 call sites off the deprecated `SubscriptionProtectedRoute`
  alias to `InstitutionRoute`, then delete `src/components/subscription/`.
- Retire `useSubscription*`, `useInstalledApps`, `useAppLifecycle`,
  `lib/admin/registry`, the command-palette "platform" surface and the
  multi-org selector paths.
- Collapse organization/business resolution to the single institution.
- Schema pass (separate, one migration at a time) for SaaS tables.

### Known debt found (not caused by M3)
`tsgo -p tsconfig.app.json` reports 52 errors, all schema/type drift after the
regenerated `types.ts` (missing `currency`, `"received"` statuses,
`business_id` on tables that no longer have it, RPC/table names absent from the
new project). These need a dedicated typing-reconciliation pass; none of them
reference removed modules.

## Next
M4 — remove POS/hardware/scanner remnants and HR beyond system actors.

## Standing constraints
- One migration at a time; no full historical seed replay.
- Exclude POS, payroll, attendance, timesheets, time-off, client portal,
  SaaS/tenant/subscription. Employees remain system actors only.
- Backend-authoritative financial design; business-event driven.
- Security posture inherited from AccrualFlow; dedicated hardening pass owed.
