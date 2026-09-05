# Microfinance Authorization Reconstruction — Investigation & Wave Plan

Status: investigation complete, implementation not started.
Scope: Access Groups, RBAC, branch scope, invitations, application authorization.

---

## 0. Executive verdict

1. **Do not rebuild.** The Access Group engine (`permission_groups` → `permission_group_rules` → `member_permission_groups` → `user_has_module_permission` → `resolveEffectivePermissions`) is sound, multi-tenant, granular (read/create/write/delete/approve/post/pay/export) and already partly wired to Lending. It must be **re-vocabularised**, not replaced.
2. **The real problem is not the group names.** It is that the system currently runs **three competing authorization models** at once:
   - Access Groups (`permission_group_rules`) — used by ~90 RLS policies and the frontend `can()` layer.
   - Hardcoded base roles (`has_role`, `role === 'admin' | 'branch_manager' | 'loan_officer' …`) — used by nearly all `mf_*` RLS policies and 6+ frontend files.
   - Business/officer scope (`user_has_business_access`, `mf_officer_in_scope`) — used as a de-facto permission inside `user_has_app_access`.
   Renaming groups without collapsing these three models produces cosmetic RBAC.
3. **Branch is not an authorization dimension yet.** `user_branch_assignments` exists, but branch is absent from invitations, absent from the session payload, absent from `user_has_module_permission`, and present in only 39 of 745 RLS policies. For a microfinance institution this is the single largest correctness gap: a Branch Manager today sees the whole national portfolio.
4. **Two P0 production defects found during the audit** (see §1.5). These are pre-existing breakages that must be fixed before any RBAC work lands, because they block the very flow that assigns permissions.
5. **Governance mode should be retained, scoped to Finance/Spend, and extended to Lending with lending-specific maker/checker rules** — not deleted and not blindly generalised.

---

## 1. Investigation findings (evidence-backed)

### 1.1 What exists and is sound
- `permission_groups` / `permission_group_rules` / `member_permission_groups`, org-scoped, with 9 action verbs plus `admin_override`.
- `user_has_module_permission(user, org, module, operation)` — SECURITY DEFINER, supports read/create/write/delete/approve/post/pay/close/reverse/export, consulted by ~90 RLS policies.
- `resolveEffectivePermissions(role, groupRules)` in `src/lib/permissions.ts` — Odoo-style additive model: internal users with groups derive permissions purely from groups; admin/owner/super_admin bypass.
- `PermissionProtectedRoute` — correct route-level enforcement pattern, already used on **every** Lending leaf route.
- `user_branch_assignments` (+ `can_view` / `can_manage` / `is_primary`), `can_access_branch`, `get_user_allowed_branches`.

### 1.2 Legacy ERP residue
- 11 seeded system groups per org, all ERP: Accountant, Attendance Officer, HR Manager, Internal User, Payroll Admin, Payroll Officer, Portal User, Project Manager, Recruiter, Sign User, Time Off Officer.
- `permission_group_rules` in the live DB covers only ERP modules (attendance, employees, leave, payroll, pos, products, projects, purchases, recruitment, sales, sign, contacts, financials, team). **There is not a single `lending` rule row in the database today.**
- Two competing seeders both exist in the live DB: `seed_default_permission_groups` (wired into org creation) and the superseded `seed_system_permission_groups`.
- `src/lib/permissions.ts` still types ~60 dead ERP permissions (POS, payroll, leave, recruitment, sign, sales, purchases) and `usePermissions` still exposes convenience booleans for all of them.
- `useAppNavigation.ts` still contains `PORTAL_HR_APPS` and an `app.id === "me"` branch referencing app ids that no longer exist in `APP_REGISTRY`.

### 1.3 Enforcement gaps
- **Finance app has zero route-level permission enforcement.** `src/apps/finance/routes.tsx` contains 0 occurrences of `PermissionProtectedRoute`; `/finance/*` is mounted behind `InstitutionRoute allowReadOnly` only, and `allowReadOnly`/`requiredFeature` are explicit no-ops. Any authenticated internal user reaching the URL sees every Finance page. Lending is correct; Finance is "hidden, not protected".
- `user_has_app_access` grants access if the user has **any** `user_business_access` row — business membership silently bypasses application-level permission gating.
- `get_user_session_data` serialises only `module, can_read, can_create, can_write, can_delete`. `can_approve / can_post / can_pay / can_export / admin_override` are **dropped**, so approve/post/pay grants never reach the frontend `can()` layer even though the DB honours them. Frontend and backend disagree.
- `mf_*` RLS uses hardcoded roles and `mf_officer_in_scope`. `mf_officer_in_scope` restricts only loan/collections officers to their own assigned records; branch managers, accountants and auditors get **org-wide** portfolio visibility.
- Duplicated `role === "admin" || "owner" || "super_admin"` triples in `Team.tsx:798`, `BusinessAccessDialog.tsx:121`, `BranchAssignmentDialog.tsx:122`, `AuditLogs.tsx:101`, `FinanceIntegrity.tsx:53`, and an inconsistent variant omitting `super_admin` in `SettingsAuditLogPanel.tsx:85`.

### 1.4 Invitations
- Invite captures email + role + optional permission groups. **No branch is captured at invite time.** Branch access is a manual post-acceptance admin step via `BranchAssignmentDialog`; a newly accepted user has zero branch access and no primary branch.
- On acceptance, if no groups were chosen, the atomic RPC falls back to the system group named `Internal Users` / `Internal User`.

### 1.5 P0 defects found (pre-existing, blocking)
Verified against the live database with `to_regproc`:
- `public.upsert_organization_invitation` — **does not exist**, yet `Team.tsx:339` calls it. Inviting a teammate fails today.
- `public.check_user_invite_allowed` — **does not exist**, called immediately before it.
- `public.accept_organization_invitation_atomic` — **does not exist**, called by the `accept-invitation` edge function.
The migrations defining these functions are in the repo but are not reflected in the live database (drift). Current data footprint is tiny (1 owner, 1 branch, 0 employees, 0 invitations, 0 group memberships), so migration risk is low — but the flow is broken.

---

## 2. Proposed Microfinance authorization model

### 2.1 Layers (each answers a different question)
| Layer | Question | Mechanism |
|---|---|---|
| Application access | May I open Lending / Finance / Reports / Settings? | `APP_REGISTRY.requiredPermissions` + `PermissionProtectedRoute` + `user_has_app_access` |
| Functional permission | May I perform this verb on this module? | Access Groups → `permission_group_rules` → `user_has_module_permission` |
| Data scope | Which branches / which portfolio rows? | `user_branch_assignments` + officer-assignment scope |
| Governance (SoD) | May *I specifically* approve this, given I created it? | `governance_mode` + `governance_assert_not_self` |

These are orthogonal and must all be satisfied. Today only layer 2 is coherent.

### 2.2 Modules (replacing the ERP module vocabulary)
`clients`, `loan_products`, `applications`, `loans`, `repayments`, `collections`, `savings` (reserved), `accounting`, `treasury`, `reports`, `branches`, `team`, `settings`, `audit`.

### 2.3 Business events that must become explicit verbs
The current broad-verb mapping (`approve`→approveApplications, `pay`→disburseLoans, `post`→recordRepayments) cannot express the events an MFI must control separately:
`approve_application`, `disburse`, `record_repayment`, `reverse_repayment`, `adjust_payment`, `waive_fee`, `restructure_loan`, `reschedule_loan`, `write_off`, `recover_written_off`, `close_loan`, `override_credit_limit`, `export_portfolio`.
Implementation: keep the 9 generic verbs on `permission_group_rules`, and add a companion `permission_group_actions(group_id, action_key, allowed)` table for these named financial events rather than widening the rules table to 20+ verbs.

### 2.4 Default Access Groups — verdict
Ship **7** system groups, branch-scoped by default, seeded per org:
1. **Institution Admin** — all modules, all verbs, all branches. Not self-assignable.
2. **Branch Manager** — full lending read/write within assigned branches; `approve_application` up to limit; no disbursement, no write-off.
3. **Loan Officer** — clients + applications create/write within own assignments; no approve, no disburse, no repayment posting.
4. **Credit Analyst / Underwriter** — read-only clients/loans, write applications, `approve_application`; no cash actions.
5. **Cashier / Teller** — `record_repayment` and `disburse` execution only; no approvals, no client edits, no reversals.
6. **Accountant** — accounting/treasury full, lending read-only, `reverse_repayment` and `adjust_payment` under governance; no approvals.
7. **Auditor** — read + export everywhere, write nowhere, at org scope (explicit exception to branch scope, flagged in the UI).

Rejected: a single "Internal User" catch-all as the acceptance fallback. The fallback becomes **Loan Officer-equivalent minimum, or no group at all** (fail closed).

### 2.5 Governance verdict
Keep `governance_mode` (solo/standard/strict) and `governance_assert_not_self` for Finance/Spend — removing it breaks existing self-approval protections and tests. Extend it to lending via explicit maker/checker triggers on application approval, disbursement, reversal, restructure and write-off. Do not collapse it to a boolean (that loses the owner/staff distinction in `standard`).

---

## 3. Implementation waves

### Wave 0 — Repair and freeze (blocking)
- Re-create the three missing RPCs (`check_user_invite_allowed`, `upsert_organization_invitation`, `accept_organization_invitation_atomic`) and add a migration-drift guard test.
- Fix `get_user_session_data` to serialise `can_approve, can_post, can_pay, can_export, admin_override`.
- Add a regression test asserting frontend-resolved permissions equal `user_has_module_permission` for the same user/module/verb.
- Exit criteria: invite → accept → permissions visible, end to end.

### Wave 1 — Vocabulary and seeding
- Add MF modules to `PermissionModule` and the Access Group UI catalogue; mark ERP modules deprecated (hidden, not deleted).
- Rewrite `seed_default_permission_groups` to seed the 7 MF groups; drop the trigger for `seed_system_permission_groups` and retire it.
- Backfill migration: per org, create MF groups and map legacy memberships (Accountant→Accountant, Internal User→Loan Officer, all others→no group + admin notification); keep legacy rows deprecated for one release.
- Exit criteria: a fresh org gets only MF groups; existing orgs keep working.

### Wave 2 — Branch scope becomes first-class
- Add `branch_scope` (`all | assigned | own_portfolio`) to `member_permission_groups`.
- Add `user_has_module_permission_in_branch(...)`; keep the old signature delegating with `branch_id = null`.
- Include allowed branches and scope mode in `get_user_session_data`; expose `useBranchScope()`.
- Capture branch(es) + primary branch **at invite time**; assign them inside the acceptance RPC.
- Exit criteria: a Branch Manager in Branch A cannot read Branch B rows via API or UI.

### Wave 3 — Collapse the competing models in `mf_*` RLS
- Produce a policy-by-policy inventory, then rewrite every `mf_*` policy onto `user_has_module_permission_in_branch(...)`, removing role literals and `has_role` from data policies.
- Keep `mf_officer_in_scope` only as the `own_portfolio` implementation, called from the new function.
- Remove the `user_business_access` bypass from `user_has_app_access`.
- Migrate in batches per table with tests between batches.
- Exit criteria: zero `mf_*` policies referencing role literals.

### Wave 4 — Financial business events + governance
- Add `permission_group_actions`; wire reversal, write-off, restructure, adjustment, waiver, limit override.
- Add lending maker/checker triggers using `governance_assert_not_self`.
- Exit criteria: the same user cannot both create and approve a disbursement in `strict` mode.

### Wave 5 — Frontend parity and cleanup
- Wrap every `src/apps/finance/routes.tsx` leaf in `PermissionProtectedRoute` (parity with Lending); audit Settings/Reports/Studio mounts the same way.
- Replace the six hardcoded `admin|owner|super_admin` triples with one `permissions.isAtLeast("admin")` helper.
- Delete dead ERP permissions, dead `usePermissions` booleans, `PORTAL_HR_APPS` and the `"me"` branch in `useAppNavigation.ts`.
- Rewrite Access Groups UI copy around branches and MF roles; add an effective-permission preview per member.
- Exit criteria: no dead permission keys; no route reachable without its declared permission.

### Wave 6 — Audit, testing, hardening
- Log every group/branch/role change to audit logs with before/after.
- Test matrix: 7 groups × MF modules × verbs × in-branch/out-of-branch, asserting DB and UI agree.
- Negative tests: direct-URL access, raw RPC calls, cross-branch reads, self-approval.
- Exit criteria: matrix green in CI.

---

## 4. Migration safety
- Live footprint is 1 owner, 1 branch, 0 employees, 0 invitations, 0 group memberships — no user currently risks losing access.
- Every wave is additive-then-cutover: new function alongside old, policies migrated in batches, legacy groups deprecated (never dropped) until Wave 5.
- Owners/admins keep full bypass throughout, so no org can lock itself out.
- Waves 0 and 1 are independently shippable; Wave 3 must not start before Wave 2 lands.



==============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============


I converged the lending security rules onto the access-group model before the pause.

Done this session
- Added two shared access checks (`mf_can`, `mf_can_scoped`) that resolve a record's institution and branch, then defer to the access-group rules — including "own portfolio only" officers.
- Rewrote the lending record rules for clients, client groups and membership, loan applications and assessments, loans, repayments and batches, collection visits, loan products and versions, and lending accounting settings. All 19 old job-title-based rules are gone (verified: zero remaining, 38 rules now use the new check).
- Closed the loophole where simply belonging to the institution granted access to every application; owners and administrators keep full access.

Still open
- Finance pages have no page-level permission check, and six screens still test for hardcoded admin roles.
- `PortalUserRoute` still carries leftover permission names from the old system.
- No dedicated permissions yet for sensitive actions (repayment reversal, write-off, restructuring).
- `.lovable/plan.md` and `roadmap.md` still show the old, inaccurate status and need updating with the verified findings.