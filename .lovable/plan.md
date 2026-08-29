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

### M3 second pass (done, verified)
- All route guards migrated to `InstitutionRoute` (App.tsx, apps/finance,
  apps/contacts, apps/hr); `src/components/subscription/**` deleted entirely
  (gate, protected-route alias, read-only banners).
- `useInstalledApps` rewritten as a registry-backed constant: every shipped
  module is available to the institution, no DB reads, install/uninstall are
  no-ops. All 20 consumers (nav, command palette, dashboard, settings) keep
  working.
- Marketplace/lifecycle UI removed: `AppMarketplace`, `InstallAppDialog`,
  `UninstallAppDialog`, `InstalledAppsHydration`, "Add Apps" affordances in
  `AppLauncher` and `AppSwitcher`.
- Hooks deleted: `useSubscription`, `useSubscriptionV2`, `useSubscriptionPlans`,
  `useSubscriptionLimits`, `useFeatureAccess`, `useAppLifecycle`,
  `useAppLifecycleState`, `useAppLifecyclePreview`.
  Replacements: `src/hooks/useEntityCreationLimits.ts` (always unlimited) and
  `src/lib/apps/lifecycle.ts` (presentational action type only).
- `SubscriptionAccessContext` is now a constant full-access module
  (`isReadOnly` always false); provider is a pass-through.
- Command palette: `buildPlatformAdminIndex` and `lib/admin/registry` deleted
  and unwired from `buildIndex`.
- Tenant ownership transfer (SaaS) removed: dialog deleted and unwired from
  `Team.tsx`.

Verification: `tsgo -p tsconfig.app.json` → 46 errors, all pre-existing schema
drift (was 52; the 6 removed were the deleted tenant-transfer dialog). No new
error file was introduced by this pass. Dev server: `/`, `/login`, `/dashboard`,
`/home`, `/settings` all 200.

### M3 remaining (must finish before M4)
- Collapse organization/business resolution to the single institution
  (`OrganizationProvider` / `BusinessProvider` / workspace routing still assume
  multi-tenant membership; `CreateOrganizationDialog` should disappear once the
  institution is a fixed configuration root).
- Residual SaaS surfaces still in code: `src/apps/platform/nav.ts`,
  `lib/pricing/*`, `services/fx/platformUsd.ts`, portal/marketing copy.
- Schema pass (separate, ONE migration, after dependency analysis) to drop SaaS
  tables/functions/policies: subscriptions, plans, plan_feature_access,
  installed apps, platform_admins, tenant_ownership_transfers, billing.

### Known debt (not caused by M3)
46 `tsgo` errors from regenerated Supabase types (missing `currency`,
`"received"` statuses, `business_id` on tables that no longer have it, RPC and
table names absent from the current project). Owed: a dedicated typing
reconciliation pass — schedule it with M7 (finance retain/adapt) at the latest.

## Currently active phase
M3 — de-SaaS the application shell. Code-side de-SaaS is ~85% complete; the
org/business collapse and the SaaS schema migration remain.

## Next agent — start here
1. VERIFY this pass first: run `npx tsgo --noEmit -p tsconfig.app.json`
   (expect 46 pre-existing errors, no subscription/app-install references),
   `rg -n "useSubscription|InstalledApps|marketplace" src`, and smoke the dev
   server routes above. Confirm no orphaned imports or dead UI branches.
2. Then finish M3: collapse organization/business resolution to the single
   institution, remove the residual SaaS surfaces listed above, and only then
   run the single SaaS schema-drop migration with a dependency check first.
3. Only after M3 is closed, proceed to M4 (POS/hardware/scanner remnants and HR
   beyond system actors). Do not jump ahead into loan-domain work.


## Standing constraints
- One migration at a time; no full historical seed replay.
- Exclude POS, payroll, attendance, timesheets, time-off, client portal,
  SaaS/tenant/subscription. Employees remain system actors only.
- Backend-authoritative financial design; business-event driven.
- Security posture inherited from AccrualFlow; dedicated hardening pass owed.
