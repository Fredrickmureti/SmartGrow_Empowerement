# Invitation acceptance / portal onboarding — architecture audit & fix

_Last updated: 2026-06-13_

## TL;DR

The reported "Error accepting invitation / Edge function returned a non-2xx
status code" was **not** an invitation-flow bug. It was a database CHECK
constraint that had drifted from the rest of the codebase: every time the
atomic accept RPC promoted an org from `solo` → `standard` governance mode
(the second member joining), the side-effect trigger
`promote_governance_mode_on_member_add` tried to write an `audit_logs` row
with `action = 'sod.governance_mode_changed'` — a value the
`audit_logs_action_check` enum did not allow. The whole transaction rolled
back, the edge function returned 500, and the user was stuck.

The audit also surfaced one real UX-level architectural flaw: the
`AcceptInvitation` page forced the invitee to self-classify as "I have an
account" vs "I'm new here". Mature SaaS (Slack, GitHub, Linear, Notion,
Atlassian, Workday) all decide that on the server from the invited email.
We now do the same.

## Changes shipped

### 1. Audit-log action constraint (root-cause fix)

Migration `20260613_*_audit_logs_action_regex` replaces the brittle
hand-maintained enum CHECK with a permissive format check:

```
CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(action) BETWEEN 1 AND 100)
```

This accepts every action literal currently emitted by triggers and edge
functions (`sod.governance_mode_changed`, `leave.approve_level1`,
`employee.pii.read`, `bill.approve`, etc.) and any future dotted /
snake_case action name. It still rejects garbage, SQL-injection-shaped
strings, and length overruns.

Note: we deliberately did **not** add `try/catch` around the trigger's
audit insert, did **not** suppress the audit row, and did **not** edit
`accept-invitation` to mask the error. The constraint was wrong; we
corrected the constraint.

### 2. Server-driven routing for invitation acceptance

New edge function `supabase/functions/resolve-invitation/index.ts`:

- Validates the token (expired / accepted / unknown — same shape that
  `validate-invitation` used to return).
- Looks up `auth.users` by the invitation email using the service role.
- Checks the caller's JWT (if present) to detect "the matching user is
  already signed in".
- Checks `user_roles` for an existing active membership in the target org.
- Returns `{ valid, invitation, route, alreadyMemberOfOrg }`, where
  `route` is one of:

  | route          | meaning |
  | -------------- | ------- |
  | `signup`       | no auth.users row for this email — render create-account form |
  | `login`        | auth.users row exists — render password-only form (email is fixed) |
  | `auto_accept`  | caller's JWT is the invited identity — auto-POST accept-invitation |
  | `already_member` | invited identity is already an active member of this org |

The response **never leaks the existing user id**; only a boolean
`existingAuthUserId` flag and the route value. This preserves the same
anti-enumeration posture as the rest of the auth surface.

`useInvitation` now calls `resolve-invitation` instead of
`validate-invitation`. `AcceptInvitation.tsx` no longer renders any
`<Tabs>` — it renders exactly one branch driven by `route`.

### 3. Architecture guard

`src/test/architecture/invitation-no-tabs.test.ts` asserts:

- `AcceptInvitation.tsx` does not import `@/components/ui/tabs`.
- It does not contain `<TabsTrigger>` / `<TabsContent>` / `<Tabs>`.
- It does not contain the literal anti-pattern strings "I have an account"
  or "I'm new here".
- The page renders branches based on `route === 'login' | 'signup'`.
- `useInvitation` calls `resolve-invitation`, not `validate-invitation`.

If a future change re-introduces self-classification UI, this test fails
in CI.

## Lifecycle / cleanup validation

Spot-checked at audit time (2026-06-13):

- `SELECT count(*) FROM organization_invitations WHERE organization_id NOT IN (SELECT id FROM organizations)` → **0**. Tenant deletion cascades correctly clean up invitations.
- `v_identity_invariants_violations` is in place (per
  `src/test/architecture/portal-identity-invariants.test.ts`) and covers
  the linked-employee / membership / multi-employee invariants.
- `employees_sync_membership_aiu` keeps `employees.user_id` and
  `user_roles` in lockstep, so linking an employee to a user never produces
  a half-state.
- The `signup_cleanup_log` / `self-reap-orphan-identity` flow is scoped to
  the standalone signup form — invitation acceptance does not interact
  with it.

## End-to-end map (post-fix)

```text
Team page → POST organization_invitations
          → send-invitation-email (tenant-scoped From — ADR 0023)

Email link → /accept-invitation?token=...
           → useInvitation → resolve-invitation (server, service-role)
                              ├── valid:false → expired/accepted/invalid screen
                              └── valid:true  → route ∈ {signup, login, auto_accept, already_member}

              route=signup     → accept-invitation { create_account:true, ... }
              route=login      → signIn → effect → accept-invitation { user_id }
              route=auto_accept → effect → accept-invitation { user_id }
              route=already_member → "go to workspace" CTA

           → RPC accept_organization_invitation_atomic
               (role upsert + employee link + perm groups + mark accepted, single tx)
           → audit_logs insert (informational, now constraint-safe)
```

## What is explicitly NOT changed

- `accept-invitation` edge function body — verified correct.
- `accept_organization_invitation_atomic` RPC — verified correct.
- `send-invitation-email` — verified correct.
- Tenant deletion cascade — verified no orphan rows.
- Vendor portal invitation flow — out of scope; same architectural shape
  applies but a separate audit cycle should retrofit `resolve-invitation`
  semantics there if/when needed.

## Files touched

- New: `supabase/functions/resolve-invitation/index.ts`
- New: `src/test/architecture/invitation-no-tabs.test.ts`
- New: `docs/audit/2026-06-13-invitation-architecture.md`
- Migration: `audit_logs_action_check` replaced with regex form
- Edit: `src/hooks/useInvitation.ts` — calls `resolve-invitation`, exposes `route`
- Edit: `src/pages/AcceptInvitation.tsx` — removes Tabs, renders single branch by route
