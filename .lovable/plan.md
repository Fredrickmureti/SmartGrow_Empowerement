# Microfinance Authorization Reconstruction — Verification & Resume Plan

Status: previous engineer's work independently verified. The app is currently **half-migrated and does not compile**. Repair first, then resume the wave sequence.

---

## 0. Verification verdict (evidence from live DB + codebase, this session)

### Claimed done — CONFIRMED
- `check_user_invite_allowed`, `upsert_organization_invitation`, `accept_organization_invitation_atomic` all now exist in the live database (earlier "missing RPC" finding is resolved).
- `get_user_session_data` now serialises the approve/post/pay/export verbs.
- `seed_default_permission_groups` was rewritten and the 7 microfinance groups exist: Institution Admin, Branch Manager, Loan Officer, Credit Analyst, Cashier / Teller, Accountant, Auditor.
- Permission rules now cover microfinance modules (clients, loan_products, applications, loans, repayments, collections, accounting, treasury, branches, audit).
- Frontend permission vocabulary in `src/lib/permissions.ts` was rewritten to microfinance-only.

### Claimed done — NOT TRUE / INCOMPLETE
1. **The app does not type-check.** `src/hooks/usePermissions.ts` still exposes ~29 deleted ERP permission keys (products, sales, purchases, payroll, POS, directory, sign); `src/lib/apps/module-app-map.ts` still declares `lending`/`financials`/ERP modules that no longer exist in the enum. Both fail compilation today. This is a broken build, not a cosmetic leftover.
2. **Legacy ERP access groups were NOT removed.** 10 ERP system groups (Accountant-legacy, HR Manager, Payroll Admin/Officer, Attendance Officer, Time Off Officer, Recruiter, Project Manager, Sign User, Portal User, Internal User) are still present with their rules, alongside the 7 new ones — 17 groups total, and rules still reference payroll/pos/sales/purchases/recruitment/leave/attendance/sign/projects/employees modules.
3. `PortalUserRoute.tsx`, `useDashboardComposition.ts`, `PermissionGate.tsx` still carry ERP references, as the log itself admitted.

### Never started (correctly listed as pending, still pending)
- **Branch scope**: no `user_has_module_permission_in_branch`, no `branch_scope` column on `member_permission_groups`, no branch in `get_user_session_data`, no branch column on `organization_invitations`. Branch is still not an authorization dimension.
- **Competing models in lending RLS**: 24 of 51 `mf_*` policies still use hardcoded role literals / `has_role`, while 90 policies elsewhere use `user_has_module_permission`.
- **Finance has zero route-level enforcement**: `src/apps/finance/routes.tsx` contains no `PermissionProtectedRoute` (lending has 35).
- Hardcoded `admin | owner | super_admin` checks still duplicated across 8 files.
- No `permission_group_actions` table for named financial events.

### Architectural findings added by this review
- **Fail-open risk in group rules**: `member_permission_groups` has no scope column, so a group grant is org-wide by construction. Every branch decision must therefore be added at the membership level, not patched per query.
- **Invitation cannot express scope**: `organization_invitations` carries `role` + `permission_group_ids` only. Branch assignment stays a manual post-acceptance step, so every newly accepted user is either branch-less or org-wide. This is the single biggest correctness gap for a multi-branch MFI.
- **Two vocabularies still coexist in the DB** (ERP rules + MF rules). Until legacy groups are deleted, an admin can still hand out payroll/POS permissions from the Access Groups UI.

---

## 1. Revised wave sequence

### Wave 0R — Restore a compiling, coherent frontend (blocking, do first)
- Strip deleted permission keys from `usePermissions.ts` (products, sales, purchases, payroll×8, POS×9, directory, sign×3) and every call site that consumes those booleans.
- Fix `module-app-map.ts`: map only the real `PermissionModule` union; delete the retired-domain keys and the `lending`/`financials` aliases (or keep `financials` if it is still in the enum — resolve to exactly one).
- Clean ERP references in `PermissionGate.tsx`, `useDashboardComposition.ts`, `PortalUserRoute.tsx`.
- Delete obsolete HR/payroll permission tests.
- Exit: `tsgo --noEmit` clean, `vitest run` green, app boots.

### Wave 1R — Finish the vocabulary cutover in the database
- Migration: delete the 10 legacy ERP system groups and their rules (0 memberships exist, so this is safe — verified), plus any rules on retired modules attached to surviving groups.
- Constrain `permission_group_rules.module` to the MF module set.
- Verify a freshly created org receives exactly the 7 MF groups.
- Exit: no ERP module or group name resolvable anywhere.

### Wave 2 — Branch scope becomes first-class
- `member_permission_groups.branch_scope` enum: `all | assigned | own_portfolio` (default `assigned`).
- New `user_has_module_permission_in_branch(user, org, branch, module, operation)`; old signature delegates with `branch_id = null`.
- `get_user_session_data` returns allowed branches + scope mode; add `useBranchScope()`.
- Add `branch_ids` + `primary_branch_id` to `organization_invitations`, capture them in the invite dialog, apply them inside the acceptance RPC.
- Exit: Branch A user cannot read Branch B rows via UI or direct API call.

### Wave 3 — Collapse competing models in `mf_*` RLS
- Inventory all 51 `mf_*` policies; rewrite the 24 role-literal ones onto `user_has_module_permission_in_branch`.
- Keep `mf_officer_in_scope` only as the `own_portfolio` implementation.
- Remove the `user_business_access` bypass inside `user_has_app_access`.
- Batch per table, test between batches.

### Wave 4 — Named financial events + governance
- `permission_group_actions(permission_group_id, action_key, allowed)` for: `approve_application`, `disburse`, `record_repayment`, `reverse_repayment`, `adjust_payment`, `waive_fee`, `restructure_loan`, `write_off`, `close_loan`, `export_portfolio`.
- Enforce in the lending server handlers and with triggers using `governance_assert_not_self` (retain governance mode for Finance/Spend; extend, do not delete).

### Wave 5 — Enforcement parity in the frontend
- Wrap every leaf in `src/apps/finance/routes.tsx` in `PermissionProtectedRoute`; audit Settings/Reports/Studio mounts identically.
- Replace the 8 duplicated `admin|owner|super_admin` checks with one `permissions.isAtLeast("admin")` helper.
- Access Groups UI: MF wording, branch scope selector, effective-permission preview per member.

### Wave 6 — Audit + end-to-end authorization matrix
- Audit-log every group/branch/role change with before/after.
- Playwright matrix: 7 groups × modules × verbs × in-branch/out-of-branch; negative tests for direct URL, raw RPC, cross-branch read, self-approval. Primary test user `fredrickmureti612@gmail.com`.

---

## 2. Standing verdicts (unchanged, re-confirmed)
- Authoritative layer: Access Groups → `permission_group_rules` → `user_has_module_permission(+branch)`. Every other layer derives from it; role literals are not an authorization source.
- Application access ≠ action authority; sensitive financial events get named action permissions.
- Governance mode: retain and extend to lending; do not remove.
- Accountants get financial authority only — never Access Group / user / security administration.
- UI hiding is never sufficient: route + server + RLS must each enforce.

---

## 3. Execution order
Wave 0R → 1R → 2 → 3 → 4 → 5 → 6. Waves 0R and 1R are independently shippable; Wave 3 must not start before Wave 2 lands. Each wave ends with a compiling app, green tests, and no half-migrated authorization.
