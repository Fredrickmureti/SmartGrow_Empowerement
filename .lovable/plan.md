# Organization Ownership, Administration & Super Admin — Investigation Verdict and Plan

## 1. What the investigation actually found (all verified against the live database and code)

**There is no Super Admin in this institution.** `super_admin` is a value in the `app_role`
list and is treated as full access in code, but **zero users hold it** (`user_roles` contains
exactly one `owner` and four `staff` rows, all active).

**The real administrator today is the Owner.** Two records agree and currently point at the
same person:
- `organizations.owner_user_id` = `7dbc67b4-…`
- `user_roles` row with `role = 'owner'` for that same user

A database rule already guarantees **one active owner per organization**
(`user_roles_one_active_owner_per_org`), and one active role row per user per organization.

**Why it feels "hardcoded".** The owner was established by seeded SQL plus a helper function
`bootstrap_super_admin(p_email)` that promotes any user found by email to `super_admin`. That
function is `SECURITY DEFINER` **with no caller check**, but it has **no grants**, so the app
cannot call it — it is a database-console escape hatch, not a live security hole. The proper
product path already exists: `create_organization_with_owner(...)` creates the organization,
sets `owner_user_id`, inserts the owner role row, creates the HQ branch and seeds the seven
system Access Groups (Institution Admin, Branch Manager, Loan Officer, Credit Analyst,
Cashier/Teller, Accountant, Auditor).

**The genuine architectural problem is not the seed. It is two competing definitions of
authority.**
1. *Role labels*: 66 database functions and 51 access rules test
   `role IN ('super_admin','owner','admin')` and grant full power. `permissions.ts` mirrors
   this with `FULL_ACCESS` for those three, explicitly making Access Groups "a no-op".
   `user_branch_scope` returns **all branches** for those labels before Access Groups are
   consulted.
2. *Access Groups*: `permission_groups` → `permission_group_rules` → `member_permission_groups`,
   evaluated per module, per operation, per branch by `mf_can` /
   `user_has_module_permission_in_branch`.

The role label always short-circuits the Access Group system. That is the accidental coupling
the brief warned about, in reverse: administration bypasses the authorization system instead of
being expressed through it.

**Missing lifecycle.** There is **no ownership-transfer function of any kind**, no `admin` role
holder, no succession path, and no protection against `organizations.owner_user_id` drifting
away from the `owner` role row. If the current owner leaves or is deactivated, the institution
has no supported way back in except direct database access.

## 2. Verdict

Industry practice across mature multi-tenant business systems (Google Workspace, Xero, Stripe,
GitHub, Odoo) converges on the same shape, and it matches how a branch microfinance institution
actually operates — the institution is *owned* by a principal, but *administered* day to day by
Head Office staff:

- **Owner** — exactly one per organization, organization-level, non-deletable, the ultimate
  recovery anchor and the only party who can transfer ownership. Authoritative field:
  `organizations.owner_user_id`. Not an Access Group.
- **Administrator** — a delegated capability held by one or more employees, expressed **through
  the existing Access Groups system** (the "Institution Admin" group plus a security-admin
  capability), never through a separate parallel mechanism.
- **Access Groups** — remain the single permission surface for everything else. Not replaced.
- **Super Admin** — retired from tenant logic. It represents a vendor/platform persona this
  single-institution product does not have.
- **Branch authority** — a Branch Manager administers *their* branches. Organization-wide
  authority must be granted explicitly; it must never be inferred from a role label.
- An **Accountant is not a Security Administrator.** Posting money and granting permissions are
  different responsibilities and stay in different Access Groups.

Nothing about the underlying architecture is unsound. Access Groups, branch scope, invitations,
membership and audit infrastructure are good and stay. What must change is: the bootstrap path,
the label short-circuit, and the absent succession lifecycle.

## 3. Waves

### Wave 1 — Make ownership consistent and unbreakable (no behaviour change)
- **Objective**: one authoritative owner record; eliminate drift.
- **Current state**: `owner_user_id` and the `owner` role row agree today but nothing enforces it.
- **Database**: trigger keeping `organizations.owner_user_id` and the active `owner` role row in
  step; block deletion/deactivation of the owner's role row; backfill any organization missing
  `owner_user_id` from its owner role row.
- **Migrations**: one small migration per object, per project convention.
- **Tests**: attempt to remove the owner role row; attempt to blank `owner_user_id`; both rejected.
- **Acceptance**: the institution can never end up with zero owners.
- **Risk**: low. **Rollback**: drop the trigger.

### Wave 2 — Retire the seeded/hardcoded bootstrap
- **Objective**: remove the identity-by-SQL path without breaking the existing installation.
- **Actions**: drop `bootstrap_super_admin`; confirm `create_organization_with_owner` is the only
  way an organization gains its first privileged user; leave the current owner exactly as is.
- **Verified dependency**: the function has no grants and no application caller, so removal is
  safe.
- **Acceptance**: no code or database path can confer authority by email or seeded id.

### Wave 3 — Collapse the two definitions of authority
- **Objective**: administration is evaluated by one surface.
- **Backend**: introduce a single helper (e.g. `is_org_administrator(user, org)`) meaning
  *owner, or holder of an administrative Access Group*; migrate the 66 functions and 51 access
  rules off the raw `('super_admin','owner','admin')` triad in reviewed batches, ordered
  lowest-risk first (reporting → settings → money-touching last).
- **Frontend**: `permissions.ts` stops granting blanket full access to role labels; the owner and
  administrative groups resolve to permissions through the same Access Group resolver.
- **Branch scope**: `user_branch_scope` returns all branches only for the owner and
  organization-wide administrative groups, never for a bare label.
- **Tests**: a Branch Manager cannot read or write another branch; an Accountant cannot alter
  Access Groups; a normal employee cannot reach Settings through a direct route or a direct
  backend call.
- **Risk**: highest wave — it touches live authorization. Executed in small, individually
  verified batches, each reversible.

### Wave 4 — Administration of Access Groups and invitations
- **Objective**: state clearly who may grant power.
- Owner and holders of a security-administration capability may create/modify/assign/revoke
  Access Groups, invite and deactivate employees, and change branch assignments. Nobody may
  grant a capability they do not themselves hold, and nobody may edit the owner.
- **Frontend**: Team and Settings screens reflect this; the owner row stays protected (already
  partially implemented in the Team screen).
- **Tests**: privilege-escalation attempts through the invitation flow and direct backend calls.

### Wave 5 — Succession, transfer and recovery
- **Objective**: the institution survives the owner leaving.
- **Ownership transfer**: initiated by the current owner only; recipient must already be an
  active internal employee of the organization; recipient must accept; password re-entry on
  initiation; effective on acceptance; the outgoing owner is demoted to an administrative Access
  Group rather than removed; abandoned transfers expire.
- **Recovery**: if the owner is deactivated or inaccessible, a documented, audited recovery path
  through an existing security administrator; database-console recovery remains the last resort
  and is explicitly documented rather than pretended away.
- **Audit**: ownership transfer, administrative grants/revocations, Access Group changes and
  deactivations are recorded through the **existing** audit infrastructure — no second audit
  system.
- **Tests**: full transfer end-to-end; abandoned transfer; transfer to a non-member rejected;
  every event visible in the audit trail.

### Wave 6 — Cleanup
- Remove `super_admin` from user-facing role lists and from tenant logic once Wave 3 is complete;
  keep the enum value itself until no function or policy references it, then retire it.
- Update the test matrix and documentation.

## 4. Explicitly out of scope
Payroll, HR, inventory, sales, and unrelated finance or microfinance modules. The Access Groups
architecture is preserved, not rebuilt.

## 5. Handoff state
Investigation is complete and evidence-backed; no implementation has started. Inspected:
`organizations`, `user_roles`, `permission_groups`, `permission_group_rules`,
`member_permission_groups`, `bootstrap_super_admin`, both `create_organization_with_owner`
overloads, `has_org_role`, `mf_can`, `user_branch_scope`, `has_dashboard_permission`, all
indexes on `user_roles`, plus `src/lib/permissions.ts`, `src/pages/Team.tsx`,
`src/pages/AcceptInvitation.tsx`, `src/pages/OnboardingSetup.tsx`. Do not repeat the counts:
66 functions and 51 access rules reference the role triad; zero users hold `super_admin`; no
ownership-transfer function exists.


=================IMPLEMENTATION PROGRESS==============

Verified against the live database (re-checked, not taken on trust):

- Wave 1 DONE. Triggers `protect_organization_owner_role` (on `user_roles`) and
  `sync_organization_owner` (on `organizations`) exist and are active. The owner cannot be
  deleted, deactivated, re-roled or blanked; a new owner must already be an active member.
- Wave 2 DONE. `bootstrap_super_admin` no longer exists in the database.
- Wave 3 DONE for the core resolvers. `is_org_administrator(user, org)` exists;
  `user_branch_scope`, `user_has_module_permission` and `has_dashboard_permission` now grant
  blanket reach only to the recorded owner, never to a role label.
- Wave 5 (part) DONE. `organization_ownership_transfers` table + RLS.

Added this session:

- Wave 5 actions: `propose_ownership_transfer`, `accept_ownership_transfer`,
  `cancel_ownership_transfer` — owner-only proposal, recipient-only acceptance, either party may
  cancel, 7-day expiry, one pending per organization, every event written to `audit_logs`
  (`ownership_transfer_proposed|accepted|cancelled`). No second audit system.
- Wave 5 UI: `src/components/settings/OwnershipCard.tsx`, mounted in
  `/settings/workspace?tab=workspace`. Shows the current owner, a pending handover with
  accept/cancel, and the owner's propose flow with confirmation.
- Wave 4: `is_org_admin_or_owner` and `is_org_manager` now delegate to `is_org_administrator`,
  so Access Group administration and invitations follow one rule (owner, or an Access Group
  granting institution-wide `team` write — today only "Institution Admin"). Dropped the two
  `organization_invitations` policies that granted invite rights from the role label alone.
  Confirmed effect on the five live users: owner unchanged; Cashier, Auditor, Branch Manager and
  Loan Officer are not administrators and none hold a team-write group.

Session of 2026-09-08 — verification + Wave 6 frontend:

- Re-verified against the live database, not taken on trust: `bootstrap_super_admin` is gone;
  `is_org_administrator`, `is_org_admin_or_owner`, `is_org_manager`, `user_branch_scope`,
  `has_dashboard_permission`, `propose_/accept_/cancel_ownership_transfer` all exist; triggers
  `sync_organization_owner` and `protect_organization_owner_role` are present;
  `organization_ownership_transfers` exists; zero users hold `super_admin`.
  `OwnershipCard` is genuinely mounted in `src/pages/settings/WorkspaceSettings.tsx`.
  Everything the previous session claimed is real.
- Wave 6 (frontend) DONE. `super_admin` and `admin` no longer map to `FULL_ACCESS` in
  `src/lib/permissions.ts` — the owner is the only blanket authority, matching the database.
  `canManageRole`/`getAssignableRoles` no longer treat `super_admin` as a manager and refuse to
  assign `owner` (ownership moves only through the audited transfer flow). Removed the dead
  `super_admin` disjuncts from `AuditLogs`, `FinanceIntegrity`, `BranchAssignmentDialog`,
  `BusinessAccessDialog`, `Team`, `useDashboardComposition`. Typecheck clean.
- Recovery documented: `docs/architecture/ORGANIZATION_OWNERSHIP.md` (model, bootstrap, transfer,
  four-step succession ladder ending in audited console-only recovery).

Remaining:

- Wave 3 tail: 61 database functions and 51 access rules still name `super_admin` in their text.
  The core resolvers no longer honour it, zero users hold the role and the frontend now grants it
  nothing, so this is dead wording rather than live authority — sweep in reviewed batches
  (reporting → settings → money last), then retire the enum value.
- Keep the `super_admin` badge/label entries in the UI maps until the enum is retired; they are
  keyed by `AppRole` and removing them earlier breaks the type.

