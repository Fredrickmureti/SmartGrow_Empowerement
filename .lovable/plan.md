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
What's now in place (verified against your live database):

The institution owner can no longer be deleted, switched off, or blanked out by accident. I tested all four ways this could happen; every one is now blocked.
The recorded owner and their membership record are kept permanently in step, and a new owner must already be an active member of the institution.
The old shortcut that could turn any account into an administrator just by email address has been removed. Nothing in the app used it.
Administration now follows one rule instead of two competing ones: full authority comes from being the recorded owner, and everyone else gets exactly what their Access Group grants. A job title no longer silently opens every branch. I checked all five existing users: the owner keeps everything, the four staff members keep only their group's access, and none of them are administrators.
I started the ownership-handover feature and created the record that tracks a pending handover.
What remains:

The handover actions themselves (propose, accept, cancel) and the Settings screen to run them.
Tightening who may create and assign Access Groups and invite staff, so an accountant is never automatically a security administrator.
Retiring the unused "Super Admin" label from the remaining older database rules and the team screens.
