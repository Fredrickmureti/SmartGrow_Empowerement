# Complete and harden team access controls

## Verified current state

- `devmuret@gmail.com` is an active `admin` in Smart Grow Empowerment, has access to the Smart Grow Empowerment company, and is assigned to **Institution Admin**.
- `fredrickmureti612@gmail.com` is the recorded owner and is also assigned to **Institution Admin**.
- The live database permission routine now grants blanket module access to an active `owner` or `admin`; the frontend mirrors this. Institution Admin has all operations enabled across the current modules.
- Existing affected members were backfilled: administrators have Institution Admin, while `mwenderose306@gmail.com` has Internal Users.
- Invitation acceptance now resolves a real default group instead of silently leaving a member without one.
- Profile, PIN, device, and login-activity settings are already available to signed-in staff. There is no signed-in **change password** control.
- The Loan Officer access group already grants read/create/write for Clients, Groups (through the Clients module), Applications, and Collections, with `own_portfolio` scope.
- Read access is correctly portfolio-scoped, but current create/update policies only check module and branch permission. A loan officer can therefore attempt to create an unassigned record or reassign a client/group outside their own portfolio. Group-member mutations have the same missing portfolio check.
- The invite dialog still allows an Internal User invitation with no selected access group. The backend fallback prevents a hollow account, but the screen does not make the intended access explicit.

## Implementation

### 1. Finish invitation safeguards

- Require at least one Access Group for every non-admin invitation in the invite screen, with a clear inline message and disabled submission until valid.
- Enforce role hierarchy in both the invite screen and RPC: only the Owner may invite an Admin; an Admin may invite internal staff but cannot create or manage peer administrators.
- Require at least one branch when the selected scope is **Assigned branches** or **Own portfolio**.
- Enforce the same invariants in `upsert_organization_invitation` so a direct request cannot bypass the screen.
- Keep Admin invitations simple: Admin remains full access, is resolved to Institution Admin, and receives all-branch scope.
- Keep the acceptance-time default-group fallback as recovery for older pending invitations, while new invitations must be explicit.

### 2. Make personal account security universal

- Keep organization controls permission-gated, but keep **Profile**, **Appearance**, **Notifications**, and **Security** available to every signed-in team member regardless of Access Group.
- Add an authenticated **Change password** panel to Security using the existing password-strength rules and Supabase account update flow.
- Link the profile menu directly to personal account/security settings so a restricted team member does not need an app permission to find them.
- Preserve per-user privacy: profile edits, PIN, devices, alerts, and login history remain limited to the signed-in user.

### 3. Make Loan Officer useful without widening scope

- Preserve Access Groups as the authority: `clients.read` shows Clients and Groups; `clients.create/write/delete` controls the matching actions. No hardcoded privilege will be added merely because the role label says Loan Officer.
- For an `own_portfolio` member, automatically assign newly created clients and groups to the signed-in officer and prevent changing the officer to someone else.
- Limit branch choices to assigned branches and preselect the member’s primary/default allowed branch.
- Tighten client and group create/update rules so an own-portfolio user can only write records whose `loan_officer_id` is their own user ID.
- Tighten group-membership add/edit/remove rules so an own-portfolio user can only manage the roll of a group assigned to them.
- Keep Admin/Owner and appropriately broader groups able to assign or reassign officers according to their branch scope.

### 4. Verify Access Groups end to end

Add regression coverage for the actual authorization chain:

- Owner and Admin: same module/app visibility and all-branch reach.
- Internal user with no group: no operational access.
- Internal user with a read-only group: pages/records visible, create/edit/delete unavailable and rejected by the database.
- Loan Officer with `own_portfolio`: can create and edit their own clients/groups, sees only assigned portfolio records, cannot assign work to another officer or mutate another officer’s group roll.
- Assigned-branch group: sees and writes only permitted branches.
- Access-group reassignment/session refresh: changing a member’s group changes navigation and actions after session refresh, with no stale privilege retained.
- Every signed-in team member can edit their own profile, set/change PIN, change password, inspect devices, and view login activity.
- Invitation validation rejects missing groups/branches and unauthorized Admin invitations at both the screen and database boundary.

Use database-level permission/RLS assertions plus focused frontend tests. Run the relevant test files, typecheck, inspect the latest build result, and perform a signed-in browser pass. If an alternate user session can be minted, verify `devmuret@gmail.com` directly; otherwise verify that account at the data layer and report the browser limitation explicitly.

### 5. Prove the authorization chain has a single source of truth

- Trace the full path (member -> role -> access group -> module operation -> branch/portfolio scope) and confirm the screen, the app menu, the server routines, and the row-level rules all read the same routine.
- Remove any remaining hardcoded email or name-based privilege; the owner must be privileged because they are recorded as owner, not because of who they are.
- Identify leftover access groups and permissions from the old business system, keep them only if harmless, and correct anything that actually interferes.
- No second permission system is introduced.

### 6. Stop duplicate clients

- Find the real cause (repeat submission, retried request, or a missing uniqueness rule) and fix it at the database layer, with the form also blocking repeat submits.
- Add a uniqueness rule based on the existing identity fields (national ID / identity document within the institution) rather than on names, so two genuinely different people with similar names are still allowed.
- Test: normal creation, double click, repeated submission, retry, same identity document, and editing an existing client.

### 7. Enforce a maximum of two groups per client

- Enforce the limit in the database so it cannot be bypassed, including under simultaneous attempts, and reject duplicate membership in the same group.
- Show a clear message in the app when the limit is reached.
- Test: first and second group allowed, third rejected, removal then re-add allowed.

### 8. Choose groups while creating the client

- In the client form, after a loan officer is chosen, offer only the groups belonging to that officer and within the allowed branches, and save the membership on the server as part of creation.
- Respect the two-group limit, existing membership, and the member's own permissions; the screen never decides membership on its own.

### 9. Make the KYC photo visible to authorized staff

- Trace upload, storage location, stored reference, access rules, and display, and fix whichever step blocks it.
- An officer allowed to see the client sees the photo; anyone else does not. The photo is never made publicly readable.

### 10. Test both allow and deny, then document

- Run the permission matrix across Dashboard, Clients, Groups, Applications, Loans, Repayments, Collections, Disbursements, Products, Portfolio, Reports, Finance, Bank Reconciliation, Fixed Assets, Settings, Team, Access Groups, Audit Logs and KYC, checking view/create/edit/delete/approve/post and data scope for owner, administrator, loan officer, restricted member, and a purpose-built custom group.
- Exercise the full group lifecycle: create group, grant a permission, attach a user, confirm access, remove the permission, confirm denial, detach the user, confirm denial.
- Confirm the server rejects direct calls that the screen would have hidden.
- Finish by rewriting this plan into the required report: architecture found, root causes, changes made, permission matrix, loan officer scope, duplicate-client fix, two-group enforcement, workflow change, KYC photo fix, tests and results, remaining defects, and anything deliberately untouched.

## Technical scope

- Small, single-purpose migrations: invitation validation, client/group/membership write rules, client uniqueness, two-group limit, storage access for KYC photos.
- Focused changes to invitations, personal security settings, client and group forms, and permission evaluation.
- No changes to loan accounting, balances, schedules, repayment allocation, or other financial logic.
==========================================
progress status
============================
I secured the access rules in the database, but the screen changes are still outstanding.

Done (live in the database):

Officers restricted to their own portfolio can now only create, edit or remove clients and groups assigned to themselves — previously they could create unassigned records or hand work to someone else.
Group membership can only be changed by someone allowed to work on that group.
Client ID photos are only viewable by staff permitted to see that specific client, instead of anyone in the institution.
The same national ID can no longer be registered twice in one institution.
A client can't be placed in more than two active groups at once.
Still to do:

Client registration screen: keep the newly created client if photo upload fails (today a retry creates a second client), default the loan officer to the signed-in officer, limit branches to those they're assigned, and let groups be chosen during registration.
Team invitation screen: require an access group and branch, and restrict who may invite an administrator.
A signed-in "change password" panel and personal security settings reachable by every staff member.
Tests, typecheck, browser verification, and the final write-up in the plan.