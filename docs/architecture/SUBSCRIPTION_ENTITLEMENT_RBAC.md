# Subscription, Entitlement, and RBAC

This document describes the three independent layers that gate access to
features in the platform. They are **independent on purpose** — a change in
one layer does not silently change another.

## Layer 1 — Subscription (org-level)

Tracked on `organizations.subscription_status`:
`trial | active | past_due | expired | cancelled | suspended`.
Driven by `subscription_plan_id` (FK → `platform_subscription_plans`) plus
`subscription_ends_at` / `trial_ends_at`. Cron expiry runs in
`check-subscription-expiry`.

Subscription suspension blocks the entire app (handled in `useAppAccess` via
`subscriptionStatus.isSuspended`). Expiry without suspension produces
read-only mode.

## Layer 2 — Entitlement (org × app)

Independent of subscription state — describes *what apps* the org can use.

### 5-state model

`useAppAccess.getAppEntitlementState(appId)` returns one of:

| State           | Meaning                                                                 | UI gesture                              |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `in_plan`       | App is included in the org's current plan via `plan_app_access`         | "Install" (free)                        |
| `trial`         | Active row in `app_trial_status` (status='active', expires_at > now)    | "Install" (trial passes entitlement)    |
| `addon`         | Not in plan, no trial, but a pricing rule exists                        | "Start free trial" + "Subscribe"        |
| `expired_trial` | Trial row exists but expired/cancelled/converted                        | "Subscribe to install" (install disabled)|
| `coming_soon`   | App registry has `comingSoon: true`                                     | Disabled tile                           |
| `overridden`    | `org_entitlement_overrides` grants explicit access                      | "Install" (free)                        |

### Install / uninstall

Both go through SQL RPCs that are the **single source of truth**:

- `install_app(p_org_id, p_app_id)`:
  - Resolves transitive dependencies (Odoo `depends:` semantics).
  - Calls `assert_entitlement` — raises `ENTITLEMENT_REQUIRED` if not in plan
    and no active trial / override.
  - Calls per-app `seed_app_data` — raises `SETUP_REQUIRED` for missing
    prerequisites (e.g. localization pack for Payroll).
  - Inserts/upserts into `organization_installed_apps` (`is_active=true`).
- `uninstall_app(p_org_id, p_app_id)`:
  - Raises `DEPENDENCY_BLOCKED` if any installed app declares this one as a
    dependency.
  - Sets `is_active=false`. **Never deletes historical data.**

### Trial lifecycle

- `start_app_trial(p_org_id, p_app_id, p_days := 14)` — creates the
  `app_trial_status` row. Entitlement passes immediately, install proceeds.
- `check-subscription-expiry` cron sweeps trials:
  - At T-3 / T-1 / T-0 days, emits a `notifications` row of category
    `subscription` linking to `/settings/apps`.
  - On T-0, marks `status='expired'`.
  - On the next sweep, if the org's plan now *includes* the app
    (`plan_app_access`), the trial row is marked `status='converted'` —
    no double-billing, no install loss.
- Manual upgrade via `ManageSubscriptionDialog` triggers the same conversion
  on its next post-update fetch.

### Overrides

`org_entitlement_overrides` lets a platform admin grant a specific app to a
specific tenant outside the plan. It surfaces as `overridden` in the
5-state model and behaves identically to `in_plan` for install/UX.

## Layer 3 — RBAC (user × module × operation)

Independent of both layers above. A user with no permissions on `payroll`
cannot reach Payroll even if the org subscribes to it.

`user_has_module_permission(_user_id, _org_id, _module, _operation)` returns
`true` when **either**:
1. The user's app-role grants the operation by default
   (`super_admin`, `owner`, `admin` always; others per a curated matrix
   in the function body), **or**
2. The user is a member of a `permission_group` whose `permission_group_rules`
   grants the operation on the module.

Portal users (`user_type='portal'`) have role-base grants forced to `false`,
so they only see what their explicit group rules allow — typically self-
service only.

### Frontend gates

- Routes use `PermissionProtectedRoute` / `OwnProfileOrPermissionRoute` to
  redirect away from forbidden pages.
- Action buttons use `usePermissions` hooks (`canManagePayroll`, etc.).
- Edge functions re-check via `_shared/permissionCheck.ts::requireModulePermission`.
  **The frontend gate is UX only** — backend is authoritative.

## Setup readiness (cross-layer)

`app_setup_status(organization_id, app_id, status, blocking_reasons jsonb)`
is updated by per-app `refresh_*_setup_status` SQL functions. It is independent
of all three layers above — an app can be in plan, the user can have full
permissions, and still the app is "not ready" because (e.g.) no salary
structure has been configured.

`useAppSetupStatus` exposes this to the UI. Marketplace tiles surface a
"Setup required" sub-row; per-app gates (e.g. `<PayrollSetupGate>`) block
the action surface until ready.

## Read-only on downgrade / uninstall

- **Subscription downgrade** that drops an app from the plan: the existing
  trial/override still grants access; otherwise users hit the marketplace
  with a "Subscribe" gesture. **Existing data is preserved.**
- **Uninstall**: `is_active=false`. RLS keeps SELECT open so reports/exports
  still work. New writes are blocked by the `assert_app_installed_for_write`
  trigger.
