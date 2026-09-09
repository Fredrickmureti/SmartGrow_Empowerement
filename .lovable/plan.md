# Client registration — branch, loan officer and group

Scope: only the relationship block (Branch / Loan officer / Group) of the client
registration form, plus the backend rules behind it. No other KYC field changes.

## A. What the system actually says today (verified)

Evidence from the live database and the code, not assumptions.

- **Client → branch**: `mf_clients.branch_id` is required, one branch per client,
  foreign key to `branches`.
- **Client → officer**: `mf_clients.loan_officer_id` is optional and has **no
  foreign key** — any UUID is accepted, including a person with no branch.
- **Client → group**: through `mf_group_members`. A trigger
  (`_mf_group_members_limit`) currently allows **two** active memberships per
  client; a partial unique index prevents joining the same group twice while
  active. Membership has `joined_on` / `exited_on` / `is_active`, so history is
  supported. Group membership is **optional** — nothing requires it.
- **Group → branch**: exactly one, required (`mf_groups.branch_id`).
- **Group → officer**: at most one, optional (`mf_groups.loan_officer_id`, no
  foreign key).
- **Officer → branch**: many-to-many via `user_branch_assignments`
  (user, business, branch, primary flag). Live data: 6 assignments, 2 branches,
  each person currently on one branch.
- **Security**: row-level rules on all three tables call `mf_can_scoped`, which
  checks business + branch permission and own-portfolio ownership. Gaps found:
  `mf_group_members.business_id` is supplied by the caller and never checked
  against the group, and nothing checks that the client, the group and the
  officer belong to the same business/branch.
- Live data is currently empty (0 clients, 0 groups), so there are no legacy
  edge cases to migrate.

**Answer to the "one group" question:** Case D — the workflow expects one, the
database permits two. You confirmed one active group is correct, so this is
fixed in the database, not hidden in the form.

## B. Current registration flow and confirmed defects

The form already has a group picker, so the "second trip to Groups" is not the
whole story. Real defects:

1. Creating a client and adding the group memberships are **separate writes**.
   If the membership write fails, a client exists with no group and no message
   explaining it.
2. The **branch list ignores the user's branch scope** (it lists every branch,
   while the save check rejects out-of-scope ones).
3. The **officer list is every organisation member**, unfiltered by branch, and
   the officer can contradict the branch.
4. The **group list silently falls back to every group in the branch** when the
   chosen officer has none — producing exactly the contradictions to avoid.
5. **No backend guard** ties client branch, group branch and officer together;
   the rules exist only in the form.
6. The two-group allowance contradicts the agreed one-group rule.

Not defects: group being optional, editing group membership from the Groups
screen, transferring branch/officer later. All preserved.

## C. What will change

### Database (three small, separate migrations)

1. Replace the membership limit trigger: **one active group per client**, with
   the message "This client already belongs to an active group. Exit that group
   first."
2. Add a membership consistency guard: the membership's business must equal the
   group's business, the client's business must equal the group's business, and
   the client's branch must equal the group's branch — each with its own plain
   sentence.
3. Add one authoritative operation `mf_register_client(...)` that creates the
   client and, when a group is given, the membership **in one transaction**,
   after checking the officer is assigned to the chosen branch. It reuses the
   existing permission function; it does not re-implement it.

### Form (relationship block only)

- Order becomes **Loan officer → Branch → Group**.
- Officer list = staff with a branch assignment in this institution.
- Choosing an officer with one branch fills the branch in automatically and
  shows it as derived; with several branches, only those branches are offered.
- Group list = groups of that officer in that branch, open groups only. No
  silent fallback to unrelated groups.
- Selecting a group when officer/branch are blank fills both in from the group.
- Group stays optional; a single choice, not a multi-select.
- Empty states in words: "This loan officer is not assigned to a branch.",
  "No groups for this loan officer in this branch.", "Select a loan officer to
  see their groups."
- Saving calls the new single operation; refusals are shown through the existing
  lending message helper, never raw database text.

## D. Verification I will run and report

Backend, by calling the operation directly with bad combinations (bypassing the
form): group from another branch, group from another business, officer not
assigned to the branch, client already in an active group, membership row with a
mistyped business. Each must be refused with its own sentence.

Front end, in the browser: officer with one branch, officer with several, officer
with no branch, officer with no groups, group-first selection, registering with
no group, and a reload after registering to confirm the membership stuck.

I will report actual observed results, including anything that fails.


========================================IMPLEMENTATION STATUS=========================

I had to stop partway. Here's where things stand.

Done (backend, live and verified as applied):

A client can now belong to only one active group at a time; a second one is refused with a clear message.
New safety check: a group membership must match the client's institution and branch, and closed groups can't take members.
New single operation mf_register_client creates the client and joins the group in one step, and refuses a loan officer who isn't assigned to the chosen branch.
Done (app):

New list of loan officers drawn from real branch assignments.
Client registration now sends the group along with the client in one save.
The form's relationship block now shows Loan officer → Branch → Group, with the branch limited to the officer's branches and the group list limited to that officer's open groups in that branch, plus plain-language empty states.
Remaining (small, all in the registration dialog file):

Finish the last three cleanups I was mid-way through: remove the now-unused two-group toggle helper and old group state, swap useOrgMembers for the new officer list, and add the chooseOfficer / chooseBranch / chooseGroup handlers and officerOptions / branchOptions / availableGroups lists the new fields reference.
Then run the type check and test the flow in the browser.
Until those handlers are added the client registration screen will not compile, so this needs one more short session to finish.