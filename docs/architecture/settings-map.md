# Settings Architecture Map (Verified, Living Document)

> Phase 0/2 deliverable of the Zero-Trust Settings Audit (see `.lovable/plan.md`).
> This document is the single reference every later phase points back to. It records
> what is actually in the codebase + DB, NOT what we wish were there.

## 1. UI Surface (verified by reading the routes)

| Page | File | Scope |
|---|---|---|
| `/settings` | `src/pages/Settings.tsx` | Redirector → workspace / company / external pages |
| `/settings/workspace` | `src/pages/settings/WorkspaceSettings.tsx` | User+org chrome (profile, security, notifications, access groups, localization, data) |
| `/settings/company` | `src/pages/settings/CompanySettings.tsx` | Company books (currency, tax, payments, terms, templates, branches) |
| `/settings/apps` | `src/pages/settings/AppsAndSubscriptions.tsx` | Installed apps, trials, addons, billing preview |
| `/settings/access-groups` | `src/pages/settings/AccessGroups.tsx` | Permission group rules |
| `/settings/profile` | `src/pages/settings/UserProfilePage.tsx` | Per-user profile |
| `/upgrade` | `src/pages/Upgrade.tsx` | Plan picker (external from settings hubs) |
| `/finance/settings` | accounting tab redirect target | Default GL accounts, fiscal periods |
| `/apps`, `/apps/:appId/activate` | `src/pages/Apps.tsx`, `src/pages/apps/AppActivate.tsx` | App marketplace |

Legacy `/settings?tab=…` deep links are preserved by `Settings.tsx` redirector.

## 2. Database Surface (verified via information_schema)

### Platform / billing layer
- `platform_apps` — app registry (id, required_plan, is_core, is_free, trial_days, is_visible_in_signup, sort_order)
- `platform_subscription_plans` — plan registry (price_monthly/yearly, price_per_user_monthly/yearly, max_users, max_installed_apps, trial_period_days, grace_period_days, base_currency)
- `app_pricing_rules` — per-app addon pricing (monthly_price, yearly_price, currency, is_per_user, is_addon_only, is_active)
- `plan_app_access` — which apps are bundled in which plan (plan_id, app_id, is_enabled)
- `plan_feature_access` — feature toggles per plan
- `platform_settings` — global key/value (timeouts, etc.)
- `currencies` — canonical currency table with symbol, code, decimal_places (used as the only source of truth for currency formatting)

### Org / subscription layer
- `organization_installed_apps` — installs per org (lifecycle_state, onboarding_status, settings jsonb)
- `app_trial_status` — per-org per-app trial (started_at, expires_at, converted_at, status)
- `org_entitlement_overrides` — per-org overrides (granted_by, reason, expires_at) — already audit-friendly
- `subscription_payments`, `subscription_usage` — billing history and metering
- `app_setup_status` — per-app readiness flags
- `app_launch_notifications` — trial-expiring notifications

### Scoping / inheritance layer
- `branch_overridable_settings` — whitelist of which keys a branch may override
- `branch_setting_overrides` — actual branch overrides
- `businesses` (a.k.a. companies) — legal entity identity (name, tax_id, address, base_currency, fiscal_year_start, logo_url, invoice/receipt prefixes)
- `branches` — operational locations under a business

### Module-specific settings
- `pos_settings`, `pos_security_settings`, `pos_hardware_configs`, `pos_happy_hours`
- `ai_settings`, `sms_provider_configs`, `payment_provider_configs`
- `tax_compliance_configs`, `default_account_settings`, `notification_alert_settings`
- `timesheet_settings`, `benefit_plans`
- `entity_field_configs`, `employee_field_configs`, `report_field_configs`

## 3. RPCs Already in Place (verified via pg_proc)

Entitlement / lifecycle:
- `app_state_for_org(_org_id, _app_id) → app_lifecycle_state` — canonical state resolver
- `assert_entitlement(p_org_id, p_app_id)` — write-side guard
- `has_app_entitlement(_org_id, _app_id) → bool`
- `start_app_trial(p_org_id, p_app_id, p_days)`
- `extend_app_trial(p_org_id, p_app_id, p_extra_days)`
- `convert_app_trials_on_plan_change(p_org_id)` — when plan upgrade absorbs an addon
- `notify_app_trial_expiring(p_org_id, p_app_id, p_days_left)`
- `check_subscription_expired(_org_id) → bool`
- `is_subscription_active`, `is_org_subscription_active`, `subscription_active_for_org`
- `get_subscription_days_remaining`, `validate_payroll_run_entitlement`

Settings resolution:
- `get_effective_company_config(p_business_id, p_branch_id)` — branch-aware company config

### Lifecycle Enum (verified)

`public.app_lifecycle_state` = `active | trial | trial_expired | suspended | uninstalled_readonly | archived`

Note: there is **no** `grace` or `read_only` enum value. The plan's seven-state model
collapses cleanly onto these six: `grace` is a sub-window of `trial_expired` (driven by
`platform_subscription_plans.grace_period_days`), and `read_only` maps to
`uninstalled_readonly`. The single canonical resolver is `app_state_for_org` — UI
must NOT recompute lifecycle from raw dates.

## 4. Hooks Map (verified)

| Hook | Purpose |
|---|---|
| `useSubscription` / `useSubscriptionV2` | Plan + status from `SessionContext` (zero-flicker) |
| `useEntitlementGate` | Single source of truth for write-action UI gating |
| `useFeatureAccess` | Feature-flag checks within a plan |
| `useAppLifecycleState` | Wraps `app_state_for_org` RPC — canonical state |
| `useAppLifecycle` | Computes the action gesture (Install / Trial / Subscribe / Open) |
| `useAppLifecyclePreview` | "What would happen if I…" preview |
| `useInstalledApps` | Install/uninstall mutations + cache |
| `useAppAccess` | Composite: entitlement state, pricing, trial |
| `useAppSetupStatus` | Per-app readiness summary |
| `useSubscriptionPlans` | Plan list from `platform_subscription_plans` |
| `useSubscriptionLimits` | Usage caps |

## 5. Currency / Price Source of Truth

**Canonical source:** `public.currencies` (code, symbol, decimal_places).

**Old (replaced):** `formatPrice(amount, currency, perUser)` was duplicated in
4 files (`AppMarketplace.tsx`, `Apps.tsx`, `AppActivate.tsx`, `AppsAndSubscriptions.tsx`)
with a hardcoded symbol map covering only USD/EUR/GBP and falling back to a literal
"USD" default.

**New canonical helper:** `src/lib/pricing/formatAppPrice.ts` (this audit). Reads
symbol + decimal places from a runtime currencies cache, never falls back to a
hardcoded literal. All four pages now import from this one util.

**Hardcoded prices:** none remain in marketplace / activate / apps-settings UI.
The only literal numbers in `landing/PricingSection.tsx` are arithmetic on plan
fields fetched from `platform_subscription_plans` (e.g. monthly = yearly/12) and
are legitimate. The `"$25/month"` reference in `InstallAppDialog.tsx` is in a
JSDoc comment, not user-facing — flagged for cleanup but harmless.

## 6. Source-of-Truth Map (critical values)

| Value | Source of truth | Resolved via | Branch-overridable? |
|---|---|---|---|
| Business name, legal name, tax ID, address | `businesses` | `get_effective_company_config` | Only if whitelisted in `branch_overridable_settings` |
| Logo, invoice/receipt prefix, receipt header/footer | `businesses` (+ `branch_setting_overrides`) | `get_effective_company_config` | Yes (whitelisted) |
| Base currency, fiscal year start, timezone | `businesses` | `get_effective_company_config` | Yes (whitelisted) |
| Default warehouse | `businesses` | `get_effective_company_config` | Yes |
| Tax rates, tax groups | `tax_rates`, `tax_groups` (org+business scope) | direct query (with `requireBusinessId`) | No (company-scoped) |
| Payment methods, bank/cash accounts | `organization_payment_methods`, `accounts` | direct query | No |
| Document templates | `document_templates` | direct query | No |
| POS configs | `pos_settings` (branch-scoped) | direct query | Branch is the scope, not an override |
| Plan / installed apps / lifecycle | `platform_subscription_plans` + `organization_installed_apps` + `app_trial_status` | `app_state_for_org`, `useSubscription` | n/a (org scope) |
| **App pricing displayed in UI** | `app_pricing_rules` + `currencies` | `formatAppPrice` util (this audit) | n/a |
| Permissions | `user_roles` + `permission_group_rules` | `usePermissions` | n/a |

## 7. Open Gaps — Status (verified 2026-04-27, pass #3)

1. ✅ **`compute_org_billing(p_org_id, p_billing_cycle)` RPC** — added and now
   wired into `AppsAndSubscriptions.tsx` (the cost summary tile reads from the
   RPC, no client-side math).
2. ✅ **`compute_org_billing_for_plan(p_org_id, p_plan_id, p_billing_cycle)`** —
   preview overload added; hook `src/hooks/useBillingPreview.ts`.
3. ✅ **Lifecycle automation** — `check-subscription-expiry` cron (jobid 1,
   02:00 daily) handles trial conversion, T-3/T-1/T-0 notifications, trial
   expiry, and grace-window expiry. State derived by `app_state_for_org`,
   consumed via `useAppLifecycleState`.
4. ✅ **`settings_audit_log`** — table added; **triggers attached** to all eight
   sensitive tables (`businesses`, `branches`, `branch_setting_overrides`,
   `tax_rates`, `payment_provider_configs`, `default_account_settings`,
   `notification_alert_settings`, `pos_settings`) in migration 20260427. The
   previous pass added the function but forgot the triggers — fixed in pass #3.
5. ✅ **`app_pricing_rules` SELECT policy** — table had RLS enabled with **zero
   policies** so the marketplace silently received `[]` for all reads and fell
   back to client constants. Added `app_pricing_rules_public_read` (anon +
   authenticated, `is_active = true`). Marketplace now reads admin-controlled
   prices.
6. ✅ **KES literal cleanup** — removed `price_monthly_kes` / `price_yearly_kes`
   reads from `Upgrade.tsx`, `landing/PricingSection.tsx`, and
   `useSubscriptionPlans.ts`. Pricing is now USD source-of-truth converted
   live via `usePricingCurrency` (which reads `platform_exchange_rates`). The
   DB columns remain for back-compat; `SubscriptionPlansSettings.tsx` (admin
   form) intentionally still exposes them as an optional KES override.
7. ✅ **Settings visibility filtering by installed apps** — wired in
   `CompanySettings.tsx` via `useInstalledApps`. Tax/Compliance hidden when
   `finance` not installed; Payments/Terms/Pay-methods require finance OR
   sales; Receipts requires `pos`; Templates requires `documents` (or finance
   fallback). While installs are loading, tabs default to visible (no flash).
8. ✅ **Branch overrides admin panel** — `BranchOverridesEditor` is rendered
   inside the Edit Business dialog (`BusinessBranchSettings.tsx`) per branch.
9. ⏳ **`<EntitlementGate>` route wrapping** — hook exists; per-route wrapping
   queued as a separate refactor (touches every page).
10. ⏳ **Drop `price_monthly_kes` / `price_yearly_kes` columns** — deferred data
    migration; UI no longer reads them so this is purely cleanup.
11. ⏳ **Backfill `platform_exchange_rates` USD→KES** — empty in DB; UI falls
    back to a 130 default. Platform admin needs to populate or wire to a
    daily FX feed.

### Odoo trial / per-app pricing alignment (research applied)

- Per-app price set by platform admin via `app_pricing_rules` (single source).
- Plan inclusion via `plan_app_access` (no charge if app is in user's plan).
- Trial: 14 days per app (config in `platform_apps.trial_days`); after expiry
  app drops to `read_only` (preserves data, blocks writes); after the 7-day
  grace, app is `suspended` (hidden from launcher, data preserved). Account
  is never terminated. Conversion logic: `convert_app_trials_on_plan_change`
  silently ends a trial when the user upgrades to a plan that includes the
  app. T-3/T-1/T-0 notifications dedup within 24h.
- Pricing display: `formatAppPrice` (canonical), `usePricingCurrency` for
  multi-currency rendering via `platform_exchange_rates`.

