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

### M3 third pass (done, verified)
Residual SaaS surfaces removed:
- Deleted `src/hooks/usePlatformAdmin.ts`, `src/contexts/PlatformIdentityContext.tsx`,
  `src/services/fx/platformUsd.ts`, `src/lib/pricing/publicPricing.ts`,
  `src/hooks/usePricingCurrency.ts`, `src/components/pricing/PricingCurrencyToggle.tsx`,
  `src/components/landing/PricingSection.tsx`.
  (`src/lib/pricing/formatAppPrice.ts` is retained — generic currency formatting
  used by `useCurrencyMap`, not SaaS pricing.)
- `useWorkspaceRouting`: `platform-admin` status and probe removed from the
  status union and the guard chain (no consumers existed).
- `useBankProviders`: admin/non-admin branch collapsed to a single RLS-scoped
  read; admin-status refetch bookkeeping removed.
- `Dashboard.tsx` / `AppSidebar.tsx`: dead platform-admin imports removed.
- `src/apps/platform/nav.ts`: "Apps" (Marketplace/App Setup), "Subscriptions"
  and the whole "Billing" group (Upgrade, Billing History) removed.

Verification: `tsgo -p tsconfig.app.json` → 46 errors, identical pre-existing
schema-drift baseline (no new file, no new error class). Dev server `/`,
`/login`, `/dashboard`, `/settings`, `/home` all 200.

### M3 remaining (must finish before M4)
- Collapse organization/business resolution to the single institution
  (`OrganizationProvider` / `BusinessProvider` / workspace routing still assume
  multi-tenant membership; `CreateOrganizationDialog` should disappear once the
  institution is a fixed configuration root).
- Marketing/portal copy still AccrualFlow-branded (rebrand lands in M6).
- Schema pass (separate, ONE migration, after dependency analysis) to drop SaaS
  tables/functions/policies: subscriptions, plans, plan_feature_access,
  installed apps, platform_admins, tenant_ownership_transfers, billing,
  platform_subscription_plans, subscription_payments, platform_exchange_rates.

### Known debt (not caused by M3)
46 `tsgo` errors from regenerated Supabase types (missing `currency`,
`"received"` statuses, `business_id` on tables that no longer have it, RPC and
table names absent from the current project). Owed: a dedicated typing
reconciliation pass — schedule it with M7 (finance retain/adapt) at the latest.

## Currently active phase
M3 — de-SaaS the application shell. Code-side de-SaaS is ~95% complete; the
org/business collapse and the SaaS schema migration remain.

## Next agent — start here
1. VERIFY this pass: `npx tsgo --noEmit -p tsconfig.app.json` (expect exactly 46
   pre-existing errors), `rg -n "usePlatformAdmin|PlatformIdentity|useSubscription|marketplace|lib/pricing/publicPricing" src`
   (expect no hits), and smoke `/`, `/login`, `/dashboard`, `/settings`, `/home`.
2. Then close M3: collapse organization/business resolution to the single
   institution (remove org creation/switching, make `currentOrg`/`currentBusiness`
   resolve from the one provisioned institution), then run the single SaaS
   schema-drop migration after a dependency check.
3. Only after M3 is closed, proceed to M4 (POS/hardware/scanner remnants and HR
   beyond system actors). Do not jump ahead into loan-domain work.



## Standing constraints
- One migration at a time; no full historical seed replay.
- Exclude POS, payroll, attendance, timesheets, time-off, client portal,
  SaaS/tenant/subscription. Employees remain system actors only.
- Backend-authoritative financial design; business-event driven.
- Security posture inherited from AccrualFlow; dedicated hardening pass owed.


===========THIS WAS THE LAST MESSAGE THE AGENT GAVE BEFORE ITS TIME RUN OUT=================
I've closed most of the remaining M3 org/business collapse work, but the plan file update is still pending.

Done this pass (code, verified by typecheck):
- Deleted `CreateOrganizationDialog` and `CreateBusinessDialog`; removed all their consumers.
- `Dashboard`: no-organization branch is now a "No institution access" message (no self-serve org creation), and `createOrganization` is no longer pulled into the page.
- `ContextSwitcherSheet` rewritten as a branch + consolidated-reporting switcher only — no workspace/company switching or creation.
- `SidebarContextSwitcher`, `AppSidebar`, `AppAwareSidebar`: `onCreateOrg` plumbing removed.
- `BusinessBranchSettings`: "Add/Create Business" affordances removed; empty state now points to central provisioning.
- `useCanSwitchScope` collapsed to branch-count + consolidated authorization; `canCreateAny`/`shouldShowCreateHint` always false, and its test rewritten to the single-institution contract (4/4 passing).
- `tsgo -p tsconfig.app.json` back at the 46-error pre-existing schema-drift baseline; no new error files.

Still open in M3 (for the next agent, in order):
1. Update `.lovable/plan.md` with the above (M3 fourth pass) — it currently still lists the org/business collapse as pending.
2. Pre-existing failing arch test `scope-trigger-visibility` flags `src/components/studio/ScheduledReportsManager.tsx` as an unguarded scope trigger (not caused by this pass) — gate it with `useCanSwitchScope()` or add a `// SCOPE-TRIGGER-EXEMPT:` note.
3. The single dependency-analyzed SaaS schema-drop migration (subscriptions, plans, installed apps, platform_admins, tenant transfers, billing, platform exchange rates).
4. Only then M4 (POS/hardware/scanner remnants, HR beyond system actors). No loan-domain work until M3 is closed.