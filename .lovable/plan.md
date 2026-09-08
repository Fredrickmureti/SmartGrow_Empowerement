# Access control report — Smart Grow Empowerment (verified 2026-09-08)

## 1. Architecture as it actually exists

Chain (single path, no second system):

```
auth user
  -> user_roles (organization_id, role, user_type, is_active)      membership
  -> member_permission_groups -> permission_groups                 access groups (many per user)
       -> permission_group_rules (module, can_read/create/write/delete/approve/post)
  -> user_has_module_permission(user, org, module, op)             one authority
  -> user_has_module_permission_in_branch(...)                     + branch grant
  -> mf_can(business, branch, module, op)                          used by all lending RLS
  -> mf_can_scoped(..., loan_officer_id)                           + portfolio scope
  -> user_branch_scope(user, org) = all | assigned | own_portfolio  data scope
```

- Roles and access groups are separate. The role gives membership level; the
  access group gives module operations. A user may hold several groups; grants
  are the union.
- Blanket authority is held by (a) the recorded organization owner
  (`organizations.owner_user_id`) and (b) the `owner`/`admin` role labels.
  There is **no email/name-based privilege anywhere** (grepped; only comments
  mention the addresses).
- Frontend gating (`usePermissions` → `resolveEffectivePermissions`) mirrors
  the same rule set: role literals + the same access-group rules loaded into
  the session, with the same owner/admin blanket rule. App menu, pages and
  actions all read that one hook; RLS re-checks server-side.
- Legacy ERP groups (Accountant, Auditor, Credit Analyst, Cashier/Teller) are
  present but scoped to modules that still exist; they do not interfere.
  Left in place deliberately.

## 2. Root causes

- **Administrator inconsistency**: `user_has_module_permission` previously
  granted nothing to a member whose access group was missing, and
  `user_branch_scope` derived reach only from an access group. `devmuret` had
  the `admin` role but no group → empty dashboard while the owner passed via
  recorded ownership. Fixed by granting blanket module access to recorded
  ownership *and* the `owner`/`admin` role, and by backfilling groups
  (administrators → Institution Admin, other staff → Internal Users).
- **Access-group failures**: hollow invitations produced members with no group.
  Now blocked in the database.

## 3. Changes made (this and the previous run)

Database: blanket-authority rules in `user_has_module_permission`;
`mf_can_scoped` (portfolio-aware) on all `mf_clients` / `mf_groups` /
`mf_group_members` policies; invitation guard in
`upsert_organization_invitation`; `mf_clients_national_id_unique`;
`mf_group_members_limit` trigger (max two active groups, advisory-locked);
`mf_group_members_active_unique`; private `mf-kyc` bucket with
`mf_can_scoped`-based select/insert/update/delete policies.

Frontend: invite screen requires an access group (and a branch for scoped
invitations) and hides the Administrator option from non-owners; personal
Security screen gained Change password for every signed-in member; client
registration locks the loan officer for own-portfolio users, limits branches to
allowed ones, offers the selected officer's groups inline, caps selection at
two, and reuses the already-created client on retry.

## 4. Verified by live database probes (all rolled back)

Permission/RLS matrix — `visible_clients` and insert attempts run under each
user's own JWT:

| user | scope | clients read/create/delete | settings.write | visible clients | insert own | insert for another officer |
|---|---|---|---|---|---|---|
| owner fredrickmureti612 | all | true/true/true | true | 8 | ALLOW | ALLOW |
| admin devmuret | all | true/true/true | true | 8 | ALLOW | ALLOW |
| internal (Internal Users) | assigned | true/false/false | false | 8 | DENY | DENY |
| loan officer (own_portfolio) | own_portfolio | true/true/false | false | 0 (none assigned) | ALLOW | **DENY** |
| auditor | all | true/false/false | false | all | DENY | DENY |

Owner and administrator are now provably equivalent, and denial is enforced by
the database, not the screen.

Integrity probes: duplicate national ID (case/space-insensitive) REJECTED;
group 1 allowed, group 2 allowed, group 3 REJECTED, duplicate membership
REJECTED, re-add after exit ALLOWED.

Invitation probes (as an administrator): staff invitation with no access group
REJECTED; branch-scoped invitation with no branch REJECTED; administrator
invitation by a non-owner REJECTED.

KYC photos: private `mf-kyc` bucket, path `business/client/...`, read through
one-hour signed URLs, storage policies gated by `mf_can_scoped('clients','read')`
— an officer authorized for the client sees the photo, nobody else does, and
nothing is public.

Typecheck: clean.

## 5. Loan Officer scope model

`own_portfolio`: clients read/create/write, applications read/create/write,
collections read/create/write, loan products/loans/repayments/reports read.
Records are visible and writable only where `loan_officer_id = auth.uid()`
(group rolls only for their own groups). Officers cannot assign work to another
officer — proven above.

## 6. Remaining defects / limitations

- Browser click-through as `devmuret` and as a loan officer was **not** run:
  this project uses an external (BYO) Supabase, so no preview session can be
  minted. Everything above was verified at the data/authorization layer.
- `Internal Users` has no `default_branch_scope`, so it falls back to
  `assigned`; it is read-only, so reach is harmless but should be set
  explicitly if that group is ever given write rules.
- Roadmap items M5a–M10 (legacy table drops, orphan function purge, report and
  document gaps) remain open and untouched.

## 7. Deliberately untouched

Loan accounting, schedules, repayment allocation, disbursement posting,
governance/segregation-of-duties functions, and orphaned ERP access groups.
