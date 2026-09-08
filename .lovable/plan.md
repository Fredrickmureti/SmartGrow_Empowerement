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

### 5. Align documentation and project rules

- Update the authorization documentation to state the shipped model exactly: Owner/Admin are blanket authorities; every other staff member receives module operations from Access Groups and record visibility from branch/portfolio scope.
- Record this authorization model in project memory so later changes cannot silently restore role-based exceptions or weaken portfolio scoping.
- Update the roadmap/plan notes only after verification succeeds.

## Technical scope

- One database migration for invitation validation and the `mf_clients`, `mf_groups`, and `mf_group_members` policy corrections; no new tables and no unrelated data changes.
- Focused changes to Team invitation validation, personal Security settings, and client/group forms.
- No changes to loan accounting, balances, schedules, repayment allocation, or other financial logic.
