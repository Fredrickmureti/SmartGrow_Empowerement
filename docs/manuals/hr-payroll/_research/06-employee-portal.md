# Research: Employee Self-Service Portal

Source: sub-agent investigation `sub_pv8p0s76`. Verified read-only against current codebase. Input for chapter `11-employee-portal.md`.

## 1. Invitation Token Flow

### 1.1 Issuing
Trigger: HR / owner inserts into `public.organization_invitations` (`id, email, role, user_type, token (uuid), expires_at, organization_id, business_id, invited_by, permission_group_ids`).
Edge fn `send-invitation-email`:
- Auth: `Authorization: Bearer <JWT>`; `supabase.auth.getClaims(token)`. Falls back to `organization_invitations.invited_by = userId` for in-progress onboarding.
- Org role check: `user_roles` must be `owner|admin|super_admin`.
- User-limit check: RPC `check_user_limit(p_org_id)`.
- Reads `platform_settings.resend_api_key`; builds HTML with `acceptUrl = ${websiteUrl}/accept-invitation?token=${invitation.token}`; fans out to `send-email` (`category:"user_invitation"`, `template_key:"invitation:user"`, ADR-0023 tenant-scoped sender).

### 1.2 Token validation
`validate-invitation` (formerly `resolve-invitation`):
- Reads `organization_invitations` by `token` (service role).
- `{ valid:false, isExpired|isAlreadyAccepted }` on bad tokens.
- Finds existing identity: `profiles.email` ilike → fallback `auth.admin.listUsers` page-1 (≤200).
- Checks `user_roles` for active membership.
- Derives `route ∈ {signup|login|auto_accept|already_member}`.
- Never leaks existing user id (only `existingAuthUser: boolean`).
- Hook `useInvitation` → `AcceptInvitation.tsx` renders exactly one branch per route (enforced by `src/test/architecture/invitation-no-tabs.test.ts`).

### 1.3 Acceptance
Edge fn `accept-invitation`:

| Path | Entry | Identity |
|---|---|---|
| `create_account` | `create_account=true` + no Authorization | `admin.auth.admin.createUser` |
| `existing-user` | `Authorization` header present | JWT `sub` claim (body `user_id` ignored) |

Create path: validates `email === invitation.email` (case-insensitive). Creates user with `email_confirm:true`, `user_metadata.account_origin="invitation"`, `onboarding_completed:true`. `"already been registered"` → `{ code:"login_required" }`. Upserts `profiles(user_id, email, full_name)`.

Race handling: `create_account=true && callerUserId` set → skips create, falls through to existing-user path.

Atomic membership write:
```
SELECT accept_organization_invitation_atomic(
  p_invitation_id uuid,
  p_user_id       uuid,
  p_permission_group_ids uuid[]
)
```
Migration `20260609085848`, SECURITY DEFINER, granted to `service_role` only. Inside (single tx, `FOR UPDATE`):
1. Revalidates `accepted_at IS NULL AND expires_at > now()`.
2. Demotion guard: existing `owner|admin|super_admin` and invitation `user_type='portal'` → `{ ok:false, code:"would_demote_admin" }`.
3. Upserts `user_roles(user_id, organization_id, role, user_type, is_active=true)`.
4. **Auto-links employee row**: `UPDATE employees SET user_id=p_user_id, user_access_status='active' WHERE org=... AND lower(email)=lower(invitation.email) AND user_id IS NULL`.
5. Replaces `member_permission_groups` (portal → "Portal User"; internal → "Internal Users").
6. Sets `organization_invitations.accepted_at=now()`.
7. Calls `record_invitation_link_outcome(...)`.

Post-accept: stamps `auth.users.user_metadata` (best-effort). Writes `audit_logs(action='user_joined')`.

## 2. `employee_credentials` Table
Migration `20260606192024_a4e1606a-…`:
```
CREATE TABLE public.employee_credentials (
  employee_id    uuid PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  kiosk_pin_hash text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);
```
Access: `REVOKE ALL FROM PUBLIC, anon, authenticated`; `GRANT ALL TO service_role`. RLS `employee_credentials_deny_all` USING/CHECK `false`. Only SECURITY DEFINER RPCs touch it: `set_employee_kiosk_pin(_employee_id, _pin)` (bcrypt), `attendance_kiosk_clock(...)` (verifies PIN, never returns it). pgTAP test 4 in `employee_pii_masking_test.sql` asserts no SELECT for `authenticated`.

## 3. `employees → auth.users` Linkage
Column `employees.user_id uuid` nullable. Trigger `employees_sync_membership_aiu` (AFTER INSERT OR UPDATE) calls `employees_sync_membership()` — keeps `user_roles` in lockstep when `user_id` is set.

Linkage events:
1. Invitation acceptance (`accept_organization_invitation_atomic`).
2. Admin manual link (HR module write permission).
3. RPC `resolve_my_employee()` — canonical resolver queried by `useCurrentEmployee`. Returns `{is_linked, employee_id, organization_id, business_id, can_self_link}`. Never raises.

`can_self_link=true` only when caller is `owner/admin/super_admin` of an org with zero employees.

## 4. Portal Role & Permissions
`user_roles.role='portal'` ↔ `user_type='portal'` enforced by trigger `trg_enforce_role_user_type` (migration `20260213165006`). Demotion guard inside accept RPC.

Default "Portal User" group:

| Module | read | create | write | delete |
|---|---|---|---|---|
| leave | ✅ | ❌ | ❌ | ❌ |
| timesheets | ✅ | ❌ | ❌ | ❌ |
| projects | ✅ | ❌ | ❌ | ❌ |

Later migrations (`20260418074430`, `20260425123957`) add `can_create=true` for leave and timesheets.

Promotion path: RPC `promote_to_internal_user(p_user_id, p_org_id, p_new_role)` — caller must be `owner|admin|super_admin`; atomic `role` + `user_type` swap.

## 5. Portal Routes (`/me/*`)
Shell `src/apps/me/MeApp.tsx` wrapped by `<SelfServiceProvider>` + `<MePortalLayout>`; mounted in `src/App.tsx:510`.

| Route | Component | Data / RPC | Mutations |
|---|---|---|---|
| `/me` | `MeHome` | `payslips` last 3 + `useLeaveAllocations.getEmployeeBalances(id)` | None |
| `/me/profile` | `MyProfile` | Redirect to `/hr/employees/:id` via `resolve_my_employee()` | None |
| `/me/payslips` | `MyPayslips` | `payslips` + `payroll_runs` join `.eq(employee_id,…)` | Download via `generate-payslip-pdf` (read) |
| `/me/leave` | `MyLeave` | `useLeaveRequests`, `useLeaveTypes`, `useLeaveAllocations` | INSERT `leave_requests` |
| `/me/attendance` | `MyAttendance` | `useMyAttendance`, `useAttendanceActions`, `useMyShiftToday` | Clock-in/out, correction requests |
| `/me/timesheets` | `MyTimesheets` | Timesheet rows scoped to employee | INSERT/UPDATE own entries |
| `/me/shifts` | `MyShifts` | Roster/shift data | Shift swap requests |
| `/me/loans` | `MyLoans` | `useMyLoans` (`employee_loans.eq(employee_id)`) | INSERT `employee_loans` (`status='requested'`); UPDATE own requested → cancelled |
| `/me/documents` | `MyDocuments` | `useMyDocuments` | UPDATE via `acknowledge_employee_document` RPC |
| `/me/onboarding` | `MyOnboarding` | Tasks for this employee | Mark complete |
| `/me/exit` | `MyExitClearance` | Exit progress | None |
| `/me/settings` | `MySettings` | `UserProfilePage` embed | name/phone/avatar |
| `/me/talent/*` | `MyTalent`, `MyGoals`, `MyReviewDetail` | `performance_goals.eq(employee_id)`, `performance_reviews` | INSERT/UPDATE own goals; UPDATE reviewer submissions |
| `/me/learning/*` | `MyLearning`, `MyCatalog`, `MyPaths` | `training_enrollments`, `training_courses` | UPDATE enrollment progress |
| `/me/team` | `MyTeamPage` | Direct reports (`employee.manager_id=currentEmployee.id`) | None |
| `/me/one-on-ones` | `MyOneOnOnes` | 1:1 records | Create/update own notes |

App-install gates: `/me/loans` gated by `<AppInstalledGate appId="payroll">`; `/me/timesheets` dimmed if timesheets not installed.

## 6. Key Portal Hooks

| Hook | File | Query | Scope |
|---|---|---|---|
| `useCurrentEmployee` | `src/hooks/useCurrentEmployee.ts` | `resolve_my_employee()` → `v_employees_safe` | Server resolver |
| `useMyLoans` | `src/hooks/useMyLoans.ts` | `employee_loans` + `loan_types` | `.eq(employee_id,…)` + RLS |
| `useMyDocuments` | `src/hooks/hr/useMyDocuments.ts` | `employee_documents` | RLS + RPC for write |
| `useMyAttendance` | `src/hooks/hr/useMyAttendance.ts` | `attendance_records` date-range | RLS |
| `useLeaveRequests` | `src/hooks/leave/useLeaveRequests.ts` | `leave_requests` | RLS; client filter |
| `useLeaveAllocations` | `src/hooks/leave/useLeaveAllocations.ts` | balances | RPC `get_employee_balance` |

## 7. PII Masking — `v_employees_safe` + `get_employee_pii`
Migration `20260606192024_a4e1606a-…` (C-HR-4).

`v_employees_safe` (security_invoker view) — column-level CASE:

| Tier | Columns | Visible to |
|---|---|---|
| Private PII | `national_id`, `date_of_birth`, `personal_phone`, `gender`, `marital_status`, address block, emergency contact | `e.user_id=auth.uid()` OR `user_can_view_employee_private(uid,org)` |
| Payroll/Bank | `bank_name`, `bank_branch`, `bank_account_number`, `bank_code` | self OR `user_can_view_employee_payroll(uid,org)` |
| Non-PII | id, employee_number, names, email, hire date, employment_type, salary, avatar | all org members |

`user_can_view_employee_private` (`SECURITY DEFINER`, `STABLE`): `super_admin|owner|admin|hr.delete|hr.write`.

Direct SELECT revoked on PII columns of base `employees` table.

`get_employee_pii(p_employee_id uuid)` (`SECURITY DEFINER`):
- Gate: `v_is_self OR (v_can_private AND v_can_payroll)`.
- INSERT `audit_logs(action='employee.pii.read', new_values={scope, fields})`.
- Returns full PII as JSONB. `GRANT EXECUTE TO authenticated`.

pgTAP (`employee_pii_masking_test.sql`): 6 assertions — view exists; auth can SELECT view; cannot SELECT raw `national_id`/`bank_account_number`; `get_employee_pii` is SECURITY DEFINER; no SELECT on `employee_credentials`.

## 8. Separation-of-Duties (SoD) Framework
Doc: `mem/features/sod-self-action.md` (Wave G2).

`self_action_policy(organization_id, action_key, mode, applies_to_role)` — `mode ∈ {block(default), warn, require_cosign, allow}`. Unique per `(org, action_key, applies_to_role)` and `(org, action_key)` where role IS NULL. RLS: all members SELECT; only `owner|super_admin` write.

`self_action_overrides(organization_id, actor_user_id, subject_user_id, action_key, reason, co_signed_by, expires_at, consumed_at)` — `length(reason) >= 12`; `co_signed_by <> actor`; `expires_at` default `now()+1h`; immutable (`trg_self_action_overrides_immutable` blocks UPDATE/DELETE unless `app.self_action_consume='true'`). RLS INSERT: `co_signed_by=auth.uid()` AND `owner|super_admin`.

Function `governance_assert_not_self(p_actor, p_subject, p_action, p_org, p_entity_type, p_entity_id)` (SECURITY DEFINER, called from `BEFORE UPDATE` triggers):
1. Short-circuit if `actor ≠ subject` or teardown flag set.
2. Lookup actor's highest role.
3. Resolve `mode` (role-specific > default > `block`).
4. `allow` → return.
5. `warn` → INSERT `audit_logs(action='sod.self_action_warn')`; return.
6. `block | require_cosign` → check unconsumed unexpired override in `self_action_overrides`. If found: set `consumed_at=now()` via `app.self_action_consume` session flag, log `sod.self_action_override_consumed`, return. Else: log `sod.self_action_blocked`, raise SQLSTATE `42501` HINT `GOV_SELF_ACTION`.

Frontend `parseGovernanceError` handles SQLSTATE `42501` hints `GOV_SELF_ACTION | GOV_APPROVER_REQUIRED | GOV_MISSING_PERMISSION`.

Surfaces covered (`sod_<table>_guard` BEFORE UPDATE): `payroll_runs, leave_requests, timesheets, employee_loans, employee_contracts, compensation_reviews, bills, payments, journal_entries, purchase_orders, expenses, refunds, credit_notes (sales + vendor), stock_adjustments, stock_transfers`.

pgTAP (`self_action_guard_test.sql`): bill self-approval blocked; cross-user succeeds; override permits one self-approval and is consumed; second self-approval blocked.

## 9. Portal RLS Scoping

| Table | Policy | USING |
|---|---|---|
| `payslips` | `org_payslips_select` | `organization_id = ANY(get_user_organization_ids())` |
| `payslip_lines` | `payslip_lines_self_select` | `payslips.employee_id IN (employees WHERE user_id=auth.uid()) AND status IN ('approved','posted','paid')` |
| `payslip_inputs` | `payslip_inputs_self_select` | same |
| `employee_loans` | INSERT self request | `status='requested' AND employee_id IN (employees WHERE user_id=auth.uid()) AND requested_by=auth.uid()` |
| `employee_loans` | UPDATE self request | `status='requested' AND employee_id IN (… user_id=auth.uid())` → only `requested→cancelled` |
| `performance_goals` | `pgoal write self or hr` | `employee_id IN (… user_id=auth.uid()) OR user_has_module_permission(...,'write')` |
| `training_enrollments` | `enrol self update progress` | `employee_id IN (… user_id=auth.uid())` |
| `employees` | `org_employees_select` | `organization_id = ANY(get_user_organization_ids())` — PII columns column-REVOKED |
| `v_employees_safe` | view CASE | per PII tier |

## 10. Account-Creation Race Conditions
1. Duplicate email — second `createUser` returns "already been registered" → `{code:"login_required"}`.
2. Mid-acceptance refresh — `create_account=true && callerUserId` set → skips create.
3. `accept_organization_invitation_atomic` holds `FOR UPDATE` on invitation row; idempotent (`{ok:false, code:"already_accepted"}` if already accepted).
4. `profiles.upsert({onConflict:"user_id"})` — concurrent-safe.
5. Governance mode upgrade race — `promote_governance_mode_on_member_add` trigger inside atomic RPC; previously failed `audit_logs.action` enum CHECK (fixed by regex `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$` in migration `20260613`).

## 11. Architecture Invariants

| Test | Guard |
|---|---|
| `invitation-no-tabs.test.ts` | No `<Tabs>` / self-classification in `AcceptInvitation.tsx`; uses `resolve-invitation` |
| `portal-identity-invariants.test.ts` | `v_identity_invariants_violations` returns 0 rows |
| `portal-payslip-contract.test.ts` | Payslip surface contract |
| `sod-coverage.test.ts` | Every action in `selfActionCatalogue.ts` has matching `sod_<table>_guard` |
| `employee_pii_masking_test.sql` | 6 PII assertions |
| `self_action_guard_test.sql` | 4 SoD invariants |
