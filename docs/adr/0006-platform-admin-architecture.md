# ADR 0006 — Platform-admin architecture: identity separation & sources of truth

**Status:** Accepted  
**Date:** 2026-04-24  
**Context tags:** `auth`, `multi-tenant`, `security`, `platform-admin`

---

## Context

The platform has two distinct populations of identities that must never be
confused at the architecture level, even when they happen to share the same
Supabase Auth user:

1. **Tenant identities** — customer-facing users who belong to one or more
   tenant workspaces. Their access is scoped per workspace and gated by
   tenant onboarding completion.
2. **Platform-admin identities** — internal staff who operate the SaaS
   control panel. Their access is independent of any tenant workspace and
   must not be blocked by tenant onboarding state.

A previous regression (`fredrickmureti612@gmail.com`) demonstrated the cost
of conflating them: the platform owner could not reach the admin dashboard
because the system tried to run him through tenant onboarding.

This ADR formalises the separation that fixes that class of bug.

## Decision

### Sources of truth

| Concept                                | Source-of-truth table                       | Notes                                                                            |
|----------------------------------------|---------------------------------------------|----------------------------------------------------------------------------------|
| Auth user (login)                      | `auth.users`                                | Supabase-managed. Never queried directly from the client.                        |
| Tenant profile                         | `public.profiles`                           | Per-auth-user. Onboarding flags live here for tenant flows only.                 |
| Tenant workspace membership            | `public.organization_members` + role table  | Scope: one auth user → many orgs.                                                |
| Platform-admin identity                | `public.platform_admins`                    | One row per platform-staff auth user. Existence here = is admin.                 |
| Platform-admin role                    | `public.platform_admins.role`               | `owner` / `admin` / `support`. Owner is unique and transferable.                 |
| Platform-admin profile (display)       | `public.platform_admins.full_name/avatar`   | Independent from `profiles` so tenant edits never leak into the admin dashboard. |
| Platform-admin sessions / PIN / MFA    | `public.platform_admin_sessions` + related  | Mirrors tenant security but stored separately.                                   |
| Platform-admin invitations             | `public.platform_admin_invitations`         | Distinct from tenant `invitations`. Different RLS, different acceptance flow.    |
| Platform integrations (FX, SMS, etc.)  | `public.platform_integration_*` tables      | Configured by admins, run by `provider-run` edge function.                       |

### Routing & guard rules

1. **Login pages must redirect already-authenticated users.** `/login` and
   `/admin/login` check the session and route to the right home:
   - has `platform_admins` row → `/admin`
   - has at least one `organization_members` row → `/app`
   - otherwise → `/onboarding`
2. **Platform-admin routes must not consult tenant onboarding.** The guard
   is `is_platform_admin(auth.uid())`, full stop.
3. **Tenant routes must not consult platform-admin status.** A platform
   admin who *also* owns a tenant business uses the normal tenant flow when
   inside `/app/...`, the admin flow when inside `/admin/...`. The two
   surfaces are siblings, not nested.
4. **"Back to App" only renders for users with both identities.** Pure
   platform admins never see it; pure tenants never see "Open admin".

### Identity coexistence rules

- **One auth user MAY hold both identities** (admin + tenant member). This
  is supported and is how the platform owner can also "dogfood" a workspace.
- **Each surface is independent**: revoking platform-admin status does not
  touch tenant memberships, and leaving a tenant does not touch admin
  status.
- **Onboarding state is per-surface**: `profiles.onboarded_at` only governs
  the tenant flow. There is no equivalent flag for admins; presence in
  `platform_admins` is itself the onboarding signal.

### Ownership transfer

The platform owner is `platform_admins.role = 'owner'`, with a uniqueness
constraint enforced at the table level. Transfer flow:

1. Current owner invites or selects an existing `admin` row.
2. Calls `transfer_platform_ownership(target_user_id)` RPC. Inside a
   transaction, the function flips the target's `role` to `owner` and the
   current owner's `role` to `admin`. Audit row written to
   `admin_audit_log`.
3. No raw SQL required. Acquisition-ready.

### Server-side enforcement

- All admin RPCs and edge functions verify `is_platform_admin(auth.uid())`
  before doing work.
- `provider-run` and the future `provider-test` accept either a
  service-role bearer (cron) or an admin-authenticated user (manual).
  Tenant tokens are rejected.
- RLS on `platform_*` tables: select/update gated by `is_platform_admin`.

### Security parity with tenants

- PIN-lock: platform admins use the same PIN UX tenants do, stored in
  `platform_admin_sessions`. Default state is **enabled** for owners,
  optional for other admins.
- MFA-readiness: schema present (`mfa_enrolled_at`); enrolment flow lands
  in a follow-up.
- Login audit: every admin login writes a row to `admin_audit_log` with
  IP, user-agent, and session-id.

## Consequences

✅  Platform-admin access is no longer breakable by tenant data corruption.  
✅  The "Unknown" display-name bug class disappears (admin display lives in
    `platform_admins`, not in tenant `profiles`).  
✅  Acquisition / ownership-transfer is a supported in-app operation, not a
    DBA task.  
✅  Future regional scoping (Kenya admin sees Kenya tenants only) is a
    column on `platform_admins` away — not an architectural rewrite.

⚠️  Two surfaces means two sets of UI to maintain. Mitigated by sharing
    primitive components (`Card`, `Table`, etc.) but **never** sharing
    page-level layouts, route guards, or onboarding logic.

## Related

- ADR 0004 — Platform Admin vs Tenant boundary (informal precursor).
- ADR 0005 — Fat edge functions (delivery vehicle for admin RPCs).
