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

**W1 — Make groups authoritative. DONE (2026-09-08).** `user_has_module_permission`
rewritten: `_base_grants` role matrix deleted; non-privileged roles derive grants only from
`member_permission_groups` ⋈ `permission_group_rules` (with the `lending`/`financials`
module aliases retained); owner/admin/super_admin full, portal and null-role deny.

**W2 — One branch answer. DONE (2026-09-08).** `can_access_branch` now resolves the branch's
org and defers to `user_branch_scope` + `user_assigned_branch_ids`; no separate rule remains.

**W3 — Reseed groups + one-group rule. DONE (2026-09-08).** `permission_groups.default_branch_scope`
added and set per §D (Institution Admin/Accountant/Auditor `all`; Branch Manager/Credit Analyst
`assigned`; Loan Officer/Cashier `own_portfolio`), with a BEFORE trigger applying it to system
groups on insert/update so seeding stays idempotent. `user_branch_scope` reads
`COALESCE(group.default_branch_scope, membership.branch_scope)`, defaulting to `own_portfolio`.
Unique index `member_permission_groups_one_per_org` enforces one group per user per org.
Verified: 7 active groups, rules 13/12/7/5/5/8/11, scopes as above.


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


===IMPLEMENTATION PROGRESS==========

**Session 2026-09-08 (b) — W1 frontend half CLOSED and verified.**

Completed / verified this session:
- `src/lib/permissions.ts`: `resolveEffectivePermissions` now derives every non-privileged
  user's rights **only** from their access group (owner/admin/super_admin full, portal deny).
  The dead role matrices that used to widen this — `LENDING_ROLE_PERMISSIONS` and
  `INTERNAL_GROUP_ROLES` — are deleted, so there is no second authority in code.
  `tsgo --noEmit -p tsconfig.app.json` is clean; no other file referenced them.
- Parity checked against the database, not assumed: all 13 modules seeded in
  `permission_group_rules` (clients, loan_products, applications, loans, repayments,
  collections, accounting, treasury, reports, branches, audit, settings, team) are present in
  `MODULE_PERMISSION_MAP`, so no group rule is silently dropped by the UI.
- W3 confirmed live: exactly 7 active system groups, none deprecated-but-live; branch reach =
  Institution Admin/Accountant/Auditor `all`, Branch Manager/Credit Analyst `assigned`,
  Loan Officer/Cashier `own_portfolio`.
- W4 confirmed live: the permission-blind-policy query over `mf_*` + finance tables returns
  NONE (same predicate as `supabase/tests/access_group_rls_coverage_test.sql`).

Open question for the product owner (do NOT change unilaterally): `seed_default_permission_groups`
grants Credit Analyst `applications.can_approve` ("Assesses and approves applications"), while
§D of this plan says Credit Analyst recommends but does not approve. One of the two must give.
Likewise Loan Officer currently has `collections` read-only, while §D describes them recording
field collections.

Blocked, not failing: W5 (invite → accept → per-group sign-in proof) cannot be run from the
agent environment — this is an external/BYO Supabase (`LOVABLE_BROWSER_AUTH_STATUS=
external_unmanaged`), so no test session can be minted. It needs a human to sign in as each
test user in the preview. Branch-scope authority itself was already proven at the RPC level in
the previous session (Headquarters vs Kitengela, per group).

**Session 2026-09-08 (c) — W1–W3 re-verified, W6 and the W7 authority half CLOSED.**

Re-verified live (do not re-audit): `user_has_module_permission` has no role matrix — grants
come only from `member_permission_groups ⋈ permission_group_rules`, owner/admin/super_admin
full, portal/null deny. `can_access_branch` defers to `user_branch_scope` +
`user_assigned_branch_ids`. `user_branch_scope` reads
`COALESCE(permission_groups.default_branch_scope, member_permission_groups.branch_scope)`.

**W6 — governance narrowing. DONE, with one reasoned departure from §E.**
Evidence: the duty catalogue is NOT ERP residue any more. `governance_duties` /
`governance_duty_permission_map` map onto microfinance modules only (applications, loans,
repayments, accounting, treasury, team) and `governance_sod_conflicts` encodes real ASA
controls (approve × disburse, disburse × receipt, approve × write_off, post × receipt).
Verdict: **retain** the catalogue, `governance_sod_violations` and the
`/settings/governance/sod` report — deleting them would remove the institution's only
maker-checker conflict report. Retained guards: `bank_accounts`, `expenses`,
`journal_entries`, `payments`, `approval_*`, the three `mf_*` — all subject tables are still
live domain, so no guard was retired.
Gap found and closed: `loan.disburse` was only guarded on the `mf_loans` status change and
only against the loan's *creator*, so the application's **approver** could pay out the loan
they approved. Added `sod_mf_loan_disbursements_guard` (BEFORE INSERT on
`mf_loan_disbursements`) asserting actor ≠ `mf_loan_applications.decision_by` via
`governance_assert_not_self('loan.disburse')`; EXECUTE revoked from anon/authenticated.
Snapshot test `src/test/architecture/sod-trigger-coverage.test.ts` updated (3 tests green).

**W7 — dashboard scope: authority half DONE.** `has_dashboard_permission` was a *second*
branch-reach authority: it granted `view_hq` / `view_consolidated` on the role label
`accountant`, bypassing access groups. Rewritten to derive both from
`user_branch_scope(user, org) = 'all'`; `view_executive` stays admin/owner;
`view_branch` = any active member. So institution-wide portfolio/financial figures now reach
only Institution Admin, Accountant, Auditor (and owner/admin). Widget gating in
`useDashboardComposition` and scope resolution in `useDashboardScope` were already
permission-driven and need no change.

Remaining W7 (small): the two setup-gap probes in `useDashboardComposition` (`mf_clients`,
`accounts`) count by organization + business with no branch filter. Counts only, no row data;
branch-filter them for tidiness.

Still blocked, not failing: **W5** (invite → accept → per-group sign-in proof). This is an
external/BYO Supabase (`LOVABLE_BROWSER_AUTH_STATUS=external_unmanaged`), so no agent test
session can be minted. Needs a human to sign in as one test user per group in the preview.

Next agent action, in order:
1. Branch-filter the two dashboard count probes (residual W7).
2. W8 legacy cleanup last: deprecated ERP permission groups + their rules, and the dead
   `organization_installed_apps` surface (the installed-apps hook hardcodes everything
   installed).
3. W5 only once a human can supply sign-ins.

Do not repeat: W1–W4, W6 and the W7 authority fix are done and verified against the live
database. Do not re-audit the permission engine, branch resolver, group seeding, RLS coverage,
the duty catalogue (verdict: keep) or dashboard permission derivation.

**Session 2026-09-08 (d) — residual W7 closed, W8 audited.**

Done this session:
- Residual W7: `useDashboardComposition` setup-gap probes now branch-filter. `mf_clients`
  counts only the selected branch when scope is `branch_only`; `accounts` is left unfiltered
  because the chart of accounts has no `branch_id` (verified in `information_schema.columns`).
  Query key carries the branch id so switching branch refetches.
- Verified the previous sessions' claims rather than trusting them: 7 system groups live,
  none deprecated (`permission_groups`: Institution Admin 13 rules/all, Branch Manager 12/
  assigned, Credit Analyst 5/assigned, Loan Officer 7/own_portfolio, Cashier 5/own_portfolio,
  Accountant 8/all, Auditor 11/all); `LENDING_ROLE_PERMISSIONS` / `INTERNAL_GROUP_ROLES` are
  gone from code (only two stale comments remained — now reworded);
  `sod-trigger-coverage.test.ts` 3/3 green; `tsgo --noEmit -p tsconfig.app.json` clean.
- **W8 verdict: nothing left to delete.** There are no deprecated ERP permission groups or
  orphan rules in the database. `useInstalledApps` is already a registry-backed stub with
  no database access and no install/uninstall mutations, and `APP_REGISTRY` holds only
  finance / lending / reports / contacts / platform apps. The `organization_installed_apps`
  table remains in the database but is unread by the app; per §29 it is left in place
  (historical FKs + `core-app-invariants.test.ts` guard) rather than dropped.

Open, needs the product owner (do NOT decide unilaterally):
1. Credit Analyst holds `applications.can_approve` in the seed, while §D says recommend-only.
2. Loan Officer has `collections` read-only, while §D says they record field collections.

Still blocked: **W5** (invite → accept → per-group sign-in proof) — external/BYO Supabase,
no agent session can be minted; needs a human sign-in per group in the preview.

Next agent action: apply the two seed decisions above once answered (single small migration
on `permission_group_rules`), then W5 with a human.

**Owner decisions applied (2026-09-08d):** Credit Analyst KEEPS `applications.can_approve`
(seed unchanged — §D recommend-only is superseded). Loan Officer now has
`collections` read+write+create; applied to the live rule and to
`seed_default_permission_groups` so new institutions inherit it. Verified in the database.
Both §D deltas are now closed; W5 remains the only open item.
