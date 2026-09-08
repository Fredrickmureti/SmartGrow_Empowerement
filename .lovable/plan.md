# Access & Permissions — audit verdict and reconstruction plan

## A. What the audit found (evidence)

**The architecture is already microfinance-shaped and there is exactly one engine.**
`permission_groups` holds 7 system groups for this institution — Institution Admin,
Branch Manager, Credit Analyst, Loan Officer, Cashier/Teller, Accountant, Auditor.
`permission_group_rules` grants 10 actions (read, create, write, delete, approve, post,
pay, close, reverse, export) across 13 modules: clients, loans, repayments, applications,
collections, loan_products, accounting, treasury, reports, audit, branches, settings, team.
Old ERP groups (HR Manager, Payroll Officer, Recruiter, Portal User, …) are already flagged
deprecated by `seed_default_permission_groups`. **Verdict: retain the architecture. No new
permission system.**

**The decisive defect: access groups cannot take anything away.**
`user_has_module_permission` returns `base_grants OR group_grants`. `base_grants` is a
hard-coded table of grants keyed only on the role label in `user_roles` — so a person
labelled `branch_manager` can read, create, write, approve, pay and close across every
lending module *regardless of the group they are in*. Groups are additive-only, i.e.
advisory. Everything downstream (sidebar, app launcher, route guards, dashboards, RLS)
reads this one function, so the whole chain inherits the flaw.

**Nothing has ever been exercised end to end.** `member_permission_groups` is empty,
`user_branch_assignments` has 1 row, `organization_invitations` has 1 invite with 0
acceptances and no groups attached, and there is exactly one user (the owner). So every
"it works" claim about groups is unproven, not wrong.

**Front end is genuinely guarded, but its authority is thin.** Route guards
(`PermissionProtectedRoute`, `InstitutionRoute`) are applied per route, so direct URLs are
blocked — not merely hidden nav. App visibility is permission-driven;
`organization_installed_apps` is dead (the installed-apps hook hardcodes everything as
installed). Of 672 RLS policies, only 77 consult module permissions and 18 consult branch;
541 are org-membership only. So the database is a coarse org boundary, not an authority.

**Branch scope is half-built.** `user_has_module_permission_in_branch` +
`user_branch_scope` + `user_assigned_branch_ids` exist and a CI test forces branch
predicates on multi-branch tables — good. But `can_access_branch` treats any org admin as
all-branches and otherwise reads `user_branch_assignments`, while group rows carry their
own `branch_scope`. Two sources of truth for the same question.

**Invitation flow is complete and sound in shape.** `upsert_organization_invitation` →
`accept-invitation` → `accept_organization_invitation_atomic` writes `user_roles`, links the
employee, rewrites `member_permission_groups`, applies branch assignments, stamps
`accepted_at`, logs lifecycle + audit. Identity comes from the JWT, never the client.
Guards block demoting the owner or the last admin. Untested, not broken.

**Governance is oversized.** A duty/conflict catalogue, action registry, SoD report page and
~22 `sod_*_guard` triggers exist, most on ERP tables. Only `mf_loans`,
`mf_loan_applications`, `mf_repayments` carry the microfinance guards. Per your decision we
keep the self-approval block (`governance_assert_not_self` + `self_action_policy`) and retire
the rest.

**Dashboard scope:** widget gating is permission-based; the setup probes count rows by
organization only, with no branch filter (counts only, not row data).

## B. Decisions taken

1. The access group is the only authority. `user_roles.role` keeps meaning only for
   `owner` / `admin` / `super_admin` (and `portal` as a hard deny).
2. Exactly one group per person.
3. All-branch reach belongs only to Institution Admin, Accountant, Auditor.
4. Governance keeps self-approval blocking; the rest is retired.

## C. Target model

```text
Organization
  └─ Branches
       └─ User ──1:1── Access Group ──> module × action rules
                        │
                        └─ branch reach: own | assigned | all
```
One question, one answer: `user_has_module_permission_in_branch(user, org, branch, module,
action)`. Frontend, route guards and RLS all ask that.

## D. Seeded groups (final)

| Group | Type | Branch reach | Core authority |
|---|---|---|---|
| Institution Admin | administrative | all | everything incl. settings, team, access groups |
| Branch Manager | operational | assigned | approve applications/loans, close, read all modules in branch |
| Credit Analyst | operational | assigned | assess & recommend applications; no approval, no cash |
| Loan Officer | operational | own | create clients & applications, record field collections |
| Cashier / Teller | operational | own | receive repayments, pay disbursements; no approval |
| Accountant | operational | all | post & reverse journals, treasury, reports; no lending approval |
| Auditor | oversight | all | read + export everywhere; no write anywhere |

Custom groups stay allowed; the 7 above are system groups and not editable.
Security administration (invite, assign groups, edit groups, audit administration) sits only
with Institution Admin and the owner — deliberately separated from financial authority, so
Accountant cannot grant itself access.

## E. Waves

**W1 — Make groups authoritative.** Rewrite `user_has_module_permission` so non-privileged
roles derive grants *only* from `member_permission_groups` ⋈ `permission_group_rules`;
keep owner/admin/super_admin full and portal deny. Delete the `_base_grants` table.
*Accept:* a user in Loan Officer cannot approve; the same user labelled `branch_manager`
still cannot approve.

**W2 — One branch answer.** Fold `can_access_branch` onto `user_branch_scope` so group
`branch_scope` is the single source; enforce the reach column in the seeder per §D.
*Accept:* a Loan Officer reading another branch's loans gets zero rows from the database,
not just a hidden menu.

**W3 — Reseed groups + one-group rule.** Update `seed_default_permission_groups` to the
§D matrix; add a unique constraint so a user holds at most one group per organization;
migrate the (currently zero) existing memberships.
*Accept:* seeding twice is idempotent; assigning a second group is refused.

**W4 — Close the RLS gap on lending & finance.** For every `mf_*`, accounting, treasury and
bank table, replace org-only policies with module+branch predicates; extend the existing CI
branch-predicate test to cover them.
*Accept:* the architecture test passes with those tables enumerated.

**W5 — Invitation provisioning proof.** Exercise invite → accept → membership → branch
assignment with real test users per group; verify revoke and group change take effect on
next session, and that changes land in the audit log.
*Accept:* each of the 7 groups signs in and sees exactly its own applications, menu,
dashboard and actions; direct URLs and direct RPC calls are refused.

**W6 — Governance narrowing.** Keep `governance_assert_not_self`, `self_action_policy`,
`self_action_overrides` and the three `mf_*` guards; add guards for disbursement approval;
retire duty/conflict catalogue, registry breadth, the SoD settings page and the ERP-table
guards, updating the architecture tests that lock them.
*Accept:* an officer cannot approve or disburse their own application; nothing else regresses.

**W7 — Dashboard scope.** Branch-filter the dashboard probes and KPI aggregates; verify a
branch user never sees institution-wide portfolio or financial figures.

**W8 — Legacy cleanup (last).** Drop deprecated ERP groups and their rules, and the dead
`organization_installed_apps` surface, only after W1–W7 are green.

Each wave is one migration or a small set of single-purpose migrations, reversible, with the
audit log untouched throughout. No wave touches Payroll/HR, Loans business logic, Accounting
posting rules or Reports.
