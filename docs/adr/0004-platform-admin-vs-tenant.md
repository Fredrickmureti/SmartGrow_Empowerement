# ADR 0004: Platform admins are not tenants

Status: Accepted (2026-04-24)

## Context

`auth.users` is a single identity store. On top of it we have two distinct
populations:

- **Platform admins** (`public.platform_admins`) — operate the SaaS.
- **Tenant users** (`public.user_roles` → `public.organizations`) — use the SaaS.

Conflating these caused a real bug: a platform owner with 0 orgs was forced
into the customer onboarding wizard and got stuck on a "Setup Error" wall.

## Decision

1. A platform admin **may not** create or join a tenant workspace under the
   same email by default. The "Create Organization" UI is hidden for them.
2. The `/dashboard` route refuses to render the customer empty state for
   platform admins; it bounces them to `/admin-management`.
3. The `AdminSidebar` "Back to App" button is only enabled when the admin
   actually has a tenant membership; otherwise it's disabled with a tooltip
   plus a "Switch account" exit.
4. To run a real business on the platform under your admin identity, use a
   **separate email** (e.g. `you@operator.com` vs `you@yourbusiness.com`).
   This mirrors how Stripe / Shopify Partners / Atlassian handle the same
   situation.
5. An escape-hatch path may be added later (`organizations.created_by_platform_admin`
   column already exists for clean audit separation when the platform is sold).

## Consequences

- Selling the platform via `platform_ownership_transfers` stays clean — the
  buyer never inherits your personal accounting workspace because operators
  don't own tenants by default.
- Audit logs are unambiguous: an action either happened in admin context or
  in tenant context, never blurred.
- New devs / agents have a written rule to follow.

## Signup recovery (companion change)

To prevent dead-end "Setup Error" screens:

- `cleanup_orphan_signups()` runs every 15 min via `pg_cron` and reaps
  unverified accounts > 24h old, and verified-but-no-workspace accounts > 2h old.
- `reset_my_signup()` lets a stuck user wipe their own broken state and
  restart from `/signup` in one click — no incognito, no support ticket.
- `<SignupRecoveryCard>` replaces the old error screen with three real
  options: Retry / Reset signup / Use a different email (which fully clears
  local Supabase storage so a new email actually works).
