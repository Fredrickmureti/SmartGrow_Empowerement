# Fix: invited admins have an empty dashboard and no app access

## What is actually happening (verified in your database)

Both accounts are in the same institution (`db06d986…fdc28`):

| Account | Role row | Access groups |
| --- | --- | --- |
| fredrickmureti612@gmail.com | `owner`, active | none |
| devmuret@gmail.com | `admin`, active | **none** |
| mwenderose306@gmail.com | `internal`, active | **none** |

Access is decided in one place — the database routine that answers "may this
person use this module". It currently grants everything **only** to the account
recorded as the institution's owner, and grants everyone else *exactly* what
their access groups allow. The front end mirrors that rule deliberately
(`src/lib/permissions.ts:299-323` — owner is blanket, every other label,
including `admin`, resolves to nothing without a group).

So there is no inconsistency between the two accounts by accident: the seeded
account is the recorded owner, and every invited person has **zero** access
groups, therefore zero permissions, therefore an empty dashboard and no apps.

Why nobody gets a group:

1. The invite screen lets you send an invitation with no group selected —
   every recent invitation row has `permission_group_ids = {}`
   (devmuret, williammutisya641, kimeumercyline71, mwenderose306).
2. The acceptance routine has a safety net that assigns a default group named
   **"Internal Users"** — that group does not exist in this institution. The
   seven groups that do exist are Institution Admin, Branch Manager, Loan
   Officer, Credit Analyst, Cashier / Teller, Accountant, Auditor. The safety
   net silently finds nothing and the member ends up with no group.
3. `member_permission_groups` is empty for the whole institution — confirming
   nobody, ever, got a group through this flow.

Secondary inconsistency: the app still *describes* Admin as "Full access"
(`src/lib/permissions.ts:401`) and the architecture doc still claims
owner/admin/super_admin always pass, while the code grants Admin nothing.
That mismatch is what makes this feel like a broken system rather than a
configuration model.

## The fix

Treat **Admin as a real administrator** (matching every label and doc in the
product and your expectation), keep access groups as the mechanism for
everyone else, and make it impossible to create a member with no access at all.

### 1. Admin becomes a blanket authority alongside Owner
- Update the permission routine so an active `owner` **or** `admin` role in the
  institution passes every module/operation check; everyone else continues to
  resolve through access groups only.
- Mirror it in the front end so the interface never shows more or less than the
  backend allows.
- Keep the audit/segregation layer untouched — self-approval limits still apply
  through the existing governance mode, so Admin is not a way around approvals.

### 2. No member can exist with zero access
- Fix the acceptance routine's default group: look up the institution's
  administrative group for admin invites and a genuine default staff group for
  everyone else, by a name that actually exists, and create that default group
  if the institution has none.
- Add the safety net at invite time too: sending an invitation with no group
  selected for a non-admin role is blocked in the invite dialog, with the
  reason shown.

### 3. Repair the people already invited
- Assign the **Institution Admin** group to the existing `admin` members
  (devmuret@gmail.com, williammutisya641@gmail.com).
- Assign the default staff group to mwenderose306@gmail.com (`internal`).
- Leave the owner as-is.

### 4. Prove it
- Re-run the permission routine for each of the three accounts across the
  lending, accounting, treasury, reports and settings modules and show the
  before/after answers.
- Sign in through the browser as the invited admin and confirm the dashboard
  and app launcher are populated (this needs the invited account's password, or
  I verify at the data layer only and you click through yourself).

### 5. Align the documentation
- Correct `docs/architecture/SUBSCRIPTION_ENTITLEMENT_RBAC.md` so the described
  rule matches the shipped rule, and record the model in project memory so a
  later session does not silently strip role authority again.

## Technical notes

- `public.user_has_module_permission(_user_id,_org_id,_module,_operation)` —
  add the role branch (`owner`,`admin`) next to the existing
  `organizations.owner_user_id` branch; the 5-arg business overload delegates
  to it so it inherits the fix. `user_has_module_permission_in_branch` keeps
  branch scoping on top, unchanged.
- `public.accept_organization_invitation_atomic` — replace the hardcoded
  `'Internal Users'` / `'Internal User'` lookup with a role-aware resolution
  plus creation of a default group when absent.
- `src/lib/permissions.ts` — `resolveEffectivePermissions` and
  `ROLE_PERMISSIONS.admin` grant full access; `ROLE_DESCRIPTIONS` copy stays
  accurate.
- `src/pages/Team.tsx:346` — block submit when a non-admin invite has no group.
- Backfill via migration `INSERT ... ON CONFLICT DO NOTHING` into
  `member_permission_groups` for the existing members.
- No change to Payments/Settlement, Accounting, Reports or Loans logic.
