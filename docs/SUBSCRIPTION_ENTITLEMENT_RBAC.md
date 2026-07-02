# Subscription, Entitlement, and RBAC Architecture

This document defines the multi-layer access enforcement model used across the
ERP. All money-touching, data-touching, and workspace-entry operations MUST
satisfy every applicable layer — there are no shortcuts and no single layer is
authoritative on its own.

## The Four Layers

Every protected operation is gated by up to four independent checks, evaluated
in this order. A failure at any layer denies the operation:

```
1. Subscription Entitlement   — does the org's plan include this app?
2. App Installation           — has the org installed this app?
3. RBAC (role/permission)     — does this user have permission for this op?
4. Setup Readiness            — is the app's required configuration in place?
```

### Layer 1 — Subscription Entitlement

**Source of truth:** `plan_app_access` joined to the org's active subscription,
plus `app_trial_status` and `org_entitlement_overrides`.

**Frontend hook:** `useAppAccess()` exposes:
  - `getAppEntitlementState(appId)` → `'in_plan' | 'trial' | 'overridden' | 'addon' | 'expired_trial' | 'coming_soon'`
  - `getAppPricing(appId)`, `getAppTrial(appId)`
  - `isReadOnly` (org-wide downgrade/expired state)

**Backend guard:** `_shared/entitlementCheck.ts` resolves the same state from
the database in every sensitive edge function.

**UX surfaces:**
  - Marketplace tiles show the entitlement badge (Included / Trial / Add-on).
  - `InstallAppDialog` shows the full dependency closure with per-line billing
    behavior before confirming an install.
  - `AppActivate` mirrors the marketplace gesture (Install / Start trial /
    Subscribe / Coming soon) and never bypasses to a raw install for add-ons.
  - `AppTrialBanner` (per-app, in workspace shell) surfaces active-trial
    countdown and expired-trial read-only state.
  - `SubscriptionReadOnlyBanner` (org-wide) surfaces full-plan downgrade.

### Layer 2 — App Installation

**Source of truth:** `installed_apps` (org_id × app_id).

**Frontend hook:** `useInstalledApps()` and `useAppEntryPath()`.

**Backend guard:** `public.org_has_app_installed(_org_id, _app_id)` security-
definer helper, called from RPCs and edge functions before any write.

**UX surfaces:**
  - Uninstalled apps render `AppLandingPage` with the activation gesture —
    they NEVER fall through to the workspace content.
  - All home/dashboard quick actions resolve through `useAppEntryPath` so
    users always land on the marketplace activation flow when needed,
    rather than into the workspace of an uninstalled app.

### Layer 3 — RBAC

**Source of truth:** `user_roles` (per-org role assignments) joined to
`role_permissions`. The `public.has_role(_user_id, _role)` security-definer
function is the canonical role probe (see `<user-roles>` directive).

**Frontend hook:** `usePermissions()` exposes `can(action)` and is used to
gate buttons, menus, and route-level guards (`PermissionProtectedRoute`).

**Backend guard:** every RLS policy on writable tables references
`has_role(auth.uid(), 'admin'|'manager'|'employee'|...)` — never a JWT claim
or a column on the user/profile row.

**Critical rule:** roles MUST live in `user_roles`, never on `profiles` or
`users`. Recursive RLS is avoided by using the SECURITY DEFINER `has_role`
function (see `<user-roles>` directive).

### Layer 4 — Setup Readiness

**Source of truth:** per-app readiness predicates exposed via SQL functions
(e.g. `assert_payroll_ready`, plus `useAppSetupStatus` on the frontend).

**Backend guard:** money-touching edge functions call `assert_*_ready()`
before computing or posting anything; failures are surfaced as structured
errors the UI can translate into a setup checklist.

**UX surfaces:** `PayrollSetupGate` (and equivalents) blocks app entry until
all required configuration is complete.

## Portal vs Internal Users

Two user_type values segregate what users may see and do:

  - **Internal users** (`user_type = 'internal'`) — staff working in the
    workspace. Routed through `AppWorkspaceLayout`. Subject to all four
    layers above.
  - **Portal users** (`user_type = 'portal'`) — employees accessing self-
    service. Routed exclusively through the `/me/*` workspace via
    `PortalLayout`. Whitelisted to a small set of HR-domain apps
    (`PORTAL_HR_APPS` in `useAppNavigation`). May NEVER see internal-only
    apps; the legacy `'hr'` alias has been removed and only the canonical
    sub-app IDs (`employees`, `time-off`, `attendance`, `payroll`,
    `recruitment`) are honoured.

The `PortalUserRoute` and `InternalOnlyRoute` guards enforce this split at
the route level.

## Trial, Add-on, and Downgrade Lifecycle

```
not entitled ──┐                              ┌── subscribe ──> in_plan
               ├── start_trial ──> trial ─────┤
addon ─────────┤        (14 days)             └── expire ─────> expired_trial
                                                                      │
                                                                      └── (read-only) ── subscribe ──> in_plan
```

**Downgrade behaviour:** when a plan downgrade removes an entitlement, the
org's `subscriptionStatus.isExpired` flips on for the affected scope; the
user retains read access (history is never destroyed) but loses write
access until they re-subscribe. The org-wide `SubscriptionReadOnlyBanner`
and the per-app `AppTrialBanner` together communicate this state.

## Where to Add a New Protected Operation

1. **If it touches money or posts to GL:** add an `assert_*_ready` SQL
   function and call it from the edge function alongside
   `org_has_app_installed` and `_shared/entitlementCheck.ts`.
2. **If it's a UI route:** wrap with `PermissionProtectedRoute` (RBAC) and
   ensure the parent app workspace runs through `AppWorkspaceLayout` (which
   handles installation + entitlement + read-only).
3. **If it's an external entry point** (deep link, webhook, share link): use
   `useAppEntryPath` so the user is routed through marketplace activation
   when the app isn't installed — never into the workspace of an
   uninstalled app.

## Anti-patterns (do NOT do)

- ❌ Storing roles on `profiles` or claiming `has_role` from a JWT claim.
- ❌ Hardcoding workspace links (`/hr/...`, `/employees/...`) — always go
  through `useAppEntryPath`.
- ❌ Trusting frontend gates as the only check for money-touching ops —
  every such op MUST be re-checked server-side.
- ❌ Surfacing `'hr'` as an installable app — it has been split into five
  sub-apps; the alias is removed.
- ❌ Treating entitlement and installation as the same thing — an org can
  be entitled (`in_plan`) without having installed the app, and vice
  versa for trials/overrides.

## Related Documentation

- `docs/HR_PAYROLL_ARCHITECTURE.md` — concrete application of all four
  layers across the HR/Payroll sub-apps.
- `docs/ORG_DATA_RESET.md` — entitlement-aware org data wipe semantics.

---

## Rule-based approval (vs hardcoded approval ceremony)

Approvals are part of **Layer 4 (Setup Readiness / Workflow)**, but they
are configured per-org by admins via Studio → Approvals — they are not
implemented inline by hardcoding `status: 'draft'` in feature hooks.

### Contract

Every action that may require approval calls a single server-side
"smart-routing" RPC that:

1. Verifies the caller's `read/create/write/delete` permission on the
   relevant module via `user_has_module_permission` (same authority RLS
   uses).
2. Loads active rows from `approval_rules` for
   `(entity_type, action_name)`.
3. Evaluates each rule's threshold against computed totals from the
   request payload (e.g. `total_value`, `total_abs_qty`).
4. If no rule matches, **or** the caller is org owner/admin (privileged
   bypass), the action is performed immediately and the audit trail
   (movements, journal entry, etc.) is written in the same transaction.
5. Otherwise the entity is stored in a `pending_approval` state and a
   matching `approval_rule_logs` row is created. The downstream effect
   (movements, GL postings, payslip release, etc.) only happens when
   an approver runs the corresponding `approve_*_atomic` RPC.

### Why this matters

Forcing every record through a "Save → Approve" two-click dance even
when no rule is configured is a degraded UX, not a control. A user who
already has `inventory.write` does not gain any safety from being
required to also click Approve on their own row — the audit log
captures who created and applied it either way. Real safety comes from:

- per-operation permission grants (`create` vs `write`),
- explicit, configurable `approval_rules`,
- immutable downstream documents (stock movements, journal entries).

### Reference implementation

- DB: `apply_or_request_stock_adjustment(jsonb, uuid)`,
  `approve_stock_adjustment_atomic(uuid, uuid)` (idempotent).
- Hook: `useInventory.createStockAdjustment`.
- Studio: register the `(entity_type, action_name)` pair in
  `ApprovalRulesManager` so admins can author rules.
- Architecture test:
  `src/test/architecture/no-hardcoded-draft-stock-adjustment.test.ts`.

New modules adopting approvals (timesheets, leave, expenses, …) MUST
follow the same pattern. Do not reintroduce a UI-only "Approve" button
gated solely on a generic `manage*` permission.
