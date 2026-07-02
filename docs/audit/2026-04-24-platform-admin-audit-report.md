# Platform Admin / Auth / Onboarding Audit — Final Report

**Date:** 2026-04-24
**Audit scope:** authentication, signup, onboarding, platform-admin
architecture, FX/integration providers, server-side enforcement.
**Triggering case:** `fredrickmureti612@gmail.com` could not access the
platform-admin dashboard because the system treated it as an incomplete
tenant signup.

---

## TL;DR

The previous agent shipped substantially more than it claimed. Re-verifying
every assertion file-by-file showed:

- **All 12 v2/v3 plan items previously called "✅ Real" remain real and
  correct.**
- **The v3 plan's "G1 Critical" finding (no FX provider UI / orchestration)
  was wrong** — `provider-run`, `provider-test`, `IntegrationProviderManager`
  with capability dispatch, and the `AdminInfrastructure` Currency tab are
  all wired and follow ADR-0005 (fat edge functions).
- **All 11 admin-only edge functions already enforce admin checks** via
  `is_platform_admin` RPC against a JWT-bound client. None are unguarded.
- **The audit trail already exists** — per-domain (`platform_integration_runs`
  for FX/integration runs, `platform_audit_logs` family for other admin
  actions where the table exists). No additional generic write was added,
  which would have been duplicative.
- **AdminProfile pulls real `full_name` from `profiles`** — "Unknown" was
  fixed at the data layer, not by a hardcoded display name.
- **`AdminSidebar.Back to App` is gated on `organizations.length > 0`** —
  pure platform admins (no tenant workspace) see "Sign out" only.

## What this loop added (small, focused, no-regression)

| Artifact | Path | Purpose |
|---|---|---|
| Shared admin-guard helper | `supabase/functions/_shared/requirePlatformAdmin.ts` | Future strictly-admin-only edge functions can throw a 401/403 in one line. **Did not** mass-refactor existing fns — investigation showed several "admin-only" candidates (`clear-org-data`, etc.) actually accept BOTH platform admins AND tenant org owners; wrapping them with a strict admin guard would have **regressed** customer-facing functionality. |
| Architectural guard tests | `src/test/architecture/auth-persona-invariants.test.ts` (13 tests, all passing) | Lock six structural invariants in CI so future regressions fail at PR time, not at runtime. |
| Audit report (this file) | `docs/audit/2026-04-24-platform-admin-audit-report.md` | Honest distinction between what was already shipped and what this loop touched. |

The 13 architecture tests enforce:

1. `/login`, `/signup`, `/forgot-password`, `/reset-password` are wrapped in `<RedirectIfAuthenticated>` (the regression that surfaced on the original report).
2. `AdminProtectedRoute` routes non-admins through `resolvePostLoginDestination` — no hard `<Navigate to="/dashboard" />` (the loop that originally locked out users with incomplete onboarding).
3. `AdminSidebar` gates the "Back to App" link on `organizations.length` AND every `to="/dashboard"` link sits inside that branch.
4. `OnboardingGuard` exempts platform admins so a SaaS operator without a tenant workspace is never forced through the customer wizard.
5. **Single source of truth** — only `PlatformIdentityContext.tsx` (plus a small allow-list with explicit justifications) may query `platform_admins` directly. All other code reads the cached value.
6. `resolvePostLoginDestination` checks `platform_admins` *before* the onboarding fallback so admins skip the wizard.

---

## 1. What was audited

| Surface | Method |
|---|---|
| Persona model (tenant vs platform admin) | Read `PlatformIdentityContext`, `usePlatformAdmin`, `OnboardingGuard`, `AdminProtectedRoute`, `RedirectIfAuthenticated`, `resolvePostLoginDestination`, `AdminSidebar`, `AdminLogin`. |
| Signup recovery reach | Verified `SignupRecoveryCard` import sites: `EnhancedLoginForm`, `SignupForm`, `OnboardingSetup`, `SignupRecoveryCardInline`. |
| FX provider integration | Read `provider-run/index.ts`, `provider-test/index.ts`, `_shared/integration-handlers/exchangeRates.ts`, `IntegrationProviderManager.tsx`, `AdminCurrencyToggle.tsx`, `AdminInfrastructure.tsx`. |
| Server-side enforcement | Spot-checked all 11 admin-only fns + `provider-run` + `provider-test` for `is_platform_admin` RPC use. |
| Admin profile data flow | Read `AdminProfile.tsx` and accept-invite migration `20260424201453_*`. |
| Edge-function quota | `ls supabase/functions \| wc -l` = **93 / 100**. Strategy is fat-function consolidation per ADR-0005. |
| ADR alignment | Read `docs/adr/0005-fat-edge-functions.md` and verified `provider-run` matches the reference shape (manual / scheduled / scheduled_batch modes). |

## 2. What was already correct (re-verified, file-evidence below)

| Concern from prompt | Status | File |
|---|---|---|
| Platform admin onboarding corruption | ✅ Fixed — `OnboardingGuard` exempts admins | `src/components/auth/OnboardingGuard.tsx:42-48` |
| Login page visible while logged in | ✅ Fixed — `RedirectIfAuthenticated` wraps every auth page | `src/App.tsx` (verified by test 1) |
| "Back to app" button shown for pure admins | ✅ Fixed — gated on `organizations.length` | `src/components/admin/AdminSidebar.tsx:111,204` |
| Profile shows "Unknown" | ✅ Fixed at data layer — `accept_platform_invitation` RPC backfills `profiles.full_name` | migration `20260424201453_*` |
| Platform-admin invitation flow | ✅ Real — `invite-platform-admin` + `accept_platform_invitation` RPC + `AdminAcceptInvitation` page |
| Admin PIN parity | ✅ Real — `AdminPinCard` + `platform_settings.allow_admin_pin_login` flag | `src/components/admin/AdminPinCard.tsx` + migration `20260424222344_*` |
| Admin sessions / device revocation | ✅ Real — `AdminSessionsCard` + `revoke-admin-session` edge fn |
| Signup partial-failure recovery | ✅ Reachable from login AND signup AND onboarding | grep above |
| FX provider — Test, Fetch now, periodic auto-refresh (default OFF) | ✅ Real — `IntegrationProviderManager` with `capabilityKey="exchange_rates"` mounted on Infrastructure → Currency tab; `auto_refresh_enabled` defaults to false in DB; `provider-run scheduled_batch` mode is the cron entry-point per ADR-0005 |
| Generic integration test surface | ✅ Real — same `IntegrationProviderManager` is reused for any capability_key (banking, payments, AI, FX, etc.) |
| Multi-currency display in admin console | ✅ Real — `AdminCurrencyToggle` lists every currency with an active rate row, no hardcoded USD/KES pair |
| AdminLogin Access-Denied panel | ✅ Removed in prior loop |
| OnboardingGate `/admin-management` allow-list | ✅ Present | `src/components/auth/OnboardingGate.tsx:35` |
| Server-side admin guards | ✅ All 11 admin-only fns (`clear-*`, `cleanup-inactive-orgs`, `load-sample-data`, `invite-platform-admin`, `notify-admin-new-signup`, `send-platform-email`, `send-admin-email`, `provider-run`, `provider-test`) call `is_platform_admin` |
| Audit trail | ✅ Per-domain — `platform_integration_runs` for integration runs, plus existing `platform_audit_logs` family migrations |

## 3. What this loop added

See "TL;DR / What this loop added" above. Net code delta:

- **+1 new file:** `supabase/functions/_shared/requirePlatformAdmin.ts` (~70 LoC, header-documented, no callers yet — kept off the critical path until a strictly-admin-only fn lands).
- **+1 new test file:** `src/test/architecture/auth-persona-invariants.test.ts` (~210 LoC, **13/13 passing**, follows the project's existing static-analysis test idiom from `no-silent-currency-fallback.test.ts`).
- **+1 new doc:** this report.
- **0 modifications** to existing source files.
- **0 new edge functions** (count stays at **93 / 100**).
- **0 new database migrations.**

## 4. Defects found this loop

None of severity Critical or High. The remaining gaps are tracked below.

## 5. Risks / known follow-ups (Medium and Low — not blocking)

| ID | Severity | Item | Why deferred |
|---|---|---|---|
| F1 | Medium | **Region-scoped admin filtering** — `platform_admin_country_scopes` table exists but listing pages (`AdminOrganizations`, `AdminUsers`) don't filter by it. A Kenya-focused operator currently sees all global tenants. | Data model is in place; UI/RLS work is a discrete next loop. |
| F2 | Medium | **Vault migration for legacy plaintext provider credentials** — new FX credentials go through `platform_integration_credentials`; legacy rows in older provider tables (e.g. SMS, banking) may still hold plaintext. | Audit-only; needs per-provider migration plan. |
| F3 | Medium | **Ownership transfer UI** — RPC + email path exist (`send-tenant-ownership-transfer`, `AcceptOwnership` page). A platform-owner-transfer flow ("hand over the SaaS itself") is not yet a UI — `is_platform_owner` is decided by `platform_admins.role = 'owner'` and currently changed via SQL only. | Lower priority than the FX/persona work; logged for next loop. |
| F4 | Low | **`requirePlatformAdmin` adoption** — helper added but not yet adopted by any function. Adoption blocked on per-function audits to distinguish "platform admin only" from "platform admin OR org owner". | Helper is harmless until adopted; intentional. |
| F5 | Low | **IP allow-listing for admin login** — out of scope; any "Coming Soon" badges should read "Roadmap". | Product decision. |

## 6. Architectural decisions confirmed (no changes this loop)

1. **Identity model (ADR-0004):** `auth.users` = identity; `platform_admins` = SaaS staff persona; `user_roles` = tenant memberships. A single email may carry both personas; `resolvePostLoginDestination` decides the active mode at login. Re-confirmed and now CI-protected by test 6 above.
2. **Fat edge functions (ADR-0005):** stay under the 100-fn ceiling by routing every "test ↔ run ↔ schedule" trio through `provider-run` / `provider-test` with a `capability_key` switch. Re-confirmed and matches the reference implementation. Future merges (per ADR-0005) target the test/etims/mpesa families.
3. **FX policy:** auto-refresh defaults OFF; manual "Fetch now" is the primary path; opt-in periodic refresh is per-connection with an interval picker. Re-confirmed in `IntegrationProviderManager` line 270 ("Periodic auto-refresh") and DB column `auto_refresh_enabled` defaulting false.
4. **Display currency:** render-time only — figures stored in USD, never rewritten on rate change. Stripe / Shopify / Linear pattern. Re-confirmed in `AdminCurrencyToggle` footer line.

## 7. Migrations applied this loop

None.

## 8. Manual database cleanup needed for existing corrupted users

None expected. The `accept_platform_invitation` backfill migration (run in a prior loop) already populates `profiles.full_name` for accepted invites. The `fredrickmureti612@gmail.com` case should now resolve at next login because the persona-redirect path, the OnboardingGuard exemption, and the `RedirectIfAuthenticated` wrapper are all in place.

If that account still shows symptoms, the `SignupRecoveryCard` is reachable from `/login`, `/signup`, and `/onboarding-setup` — the operator can self-heal without admin intervention.

## 9. Test results

```
✓ src/test/architecture/auth-persona-invariants.test.ts (13 tests) 118 ms
  ✓ App.tsx imports RedirectIfAuthenticated
  ✓ /login route is wrapped in RedirectIfAuthenticated
  ✓ /signup route is wrapped in RedirectIfAuthenticated
  ✓ /forgot-password route is wrapped in RedirectIfAuthenticated
  ✓ /reset-password route is wrapped in RedirectIfAuthenticated
  ✓ AdminProtectedRoute imports resolvePostLoginDestination
  ✓ AdminProtectedRoute does not hard-redirect non-admins to /dashboard
  ✓ AdminSidebar checks organizations.length before Back to App
  ✓ AdminSidebar never renders an unconditional /dashboard link
  ✓ OnboardingGuard imports usePlatformAdmin
  ✓ OnboardingGuard returns early when isPlatformAdmin is true
  ✓ No source file outside PlatformIdentityContext queries platform_admins directly
  ✓ postLoginRedirect checks platform_admins before onboarding fallback

Test Files  1 passed (1)
     Tests  13 passed (13)
```

5 unrelated pre-existing failures elsewhere in `src/test/architecture/` (POS branch stamping, business-scoped queries) — **not** caused by this loop.

## 10. Files changed this loop

- **Added:** `supabase/functions/_shared/requirePlatformAdmin.ts`
- **Added:** `src/test/architecture/auth-persona-invariants.test.ts`
- **Added:** `docs/audit/2026-04-24-platform-admin-audit-report.md` (this file)

No source files modified. No migrations added. No edge functions deployed.
