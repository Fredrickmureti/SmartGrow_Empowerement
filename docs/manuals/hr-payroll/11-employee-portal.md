# 11 · Employee Self-Service Portal

## Purpose
What an employee can do with their own login. Includes the full invitation flow, the linkage between `employees.user_id` and `auth.users`, every `/me/*` route, PII masking, and the Separation-of-Duties framework that protects sensitive actions.

## Invitation flow end-to-end

### Issue
HR inserts a row into `organization_invitations` (`id, token (uuid), email, role, user_type, permission_group_ids, expires_at, organization_id, business_id, invited_by`). Edge fn `send-invitation-email`:
- Validates caller JWT and confirms `owner|admin|super_admin` membership in the target org.
- Checks `check_user_limit(p_org_id)` RPC against the org's plan.
- Builds HTML with `acceptUrl = ${websiteUrl}/accept-invitation?token=...`.
- Delegates to `send-email` with `category: "user_invitation"`, `template_key: "invitation:user"`, ADR-0023 sender resolution.

### Validate
Edge fn `validate-invitation` (formerly `resolve-invitation`):
- Reads invitation by `token` (service role).
- Looks up existing identity (`profiles.email` ilike, fallback `auth.admin.listUsers` page-1 ≤200).
- Returns `route ∈ {signup, login, auto_accept, already_member}`. Never leaks the user id (only `existingAuthUser: boolean`).
- Front-end `useInvitation` hook → `AcceptInvitation.tsx` picks one branch. Architecture test `invitation-no-tabs.test.ts` blocks self-classification UI.

### Accept (`accept-invitation`)
Two paths:

| Path | Entry | Identity source |
|---|---|---|
| `create_account` | `create_account=true` + no Authorization header | `admin.auth.admin.createUser` (`email_confirm:true`, `user_metadata.account_origin="invitation"`, `onboarding_completed:true`) |
| `existing-user` | `Authorization` header present | JWT `sub` claim (body `user_id` is ignored — defense-in-depth) |

Race-condition guard: if `create_account=true` but the request already has a session, the create branch is skipped silently.

Atomic membership write (`accept_organization_invitation_atomic`, migration `20260609085848`, SECURITY DEFINER, granted only to service_role) — single transaction with `FOR UPDATE` on the invitation row:
1. Revalidates `accepted_at IS NULL AND expires_at > now()`.
2. **Demotion guard**: existing role is `owner|admin|super_admin` AND invitation `user_type='portal'` → returns `{ ok:false, code:"would_demote_admin" }`.
3. Upserts `user_roles(user_id, organization_id, role, user_type, is_active=true)`.
4. **Auto-links employee row**: `UPDATE employees SET user_id=p_user_id, user_access_status='active' WHERE organization_id=… AND lower(email)=lower(invitation.email) AND user_id IS NULL`.
5. Replaces `member_permission_groups` for the user (portal → "Portal User"; internal → "Internal Users").
6. Sets `organization_invitations.accepted_at = now()`.
7. Calls `record_invitation_link_outcome(...)`.

Post-accept: stamps `auth.users.user_metadata` (best-effort), writes `audit_logs(action='user_joined')`.

**Risk** (Chapter 13): `admin.createUser` runs **outside** the SQL transaction. A crash between the Deno auth call and the RPC can leave an auth user with no org membership.

## `employee_credentials` (kiosk only)

```sql
CREATE TABLE public.employee_credentials (
  employee_id    uuid PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  kiosk_pin_hash text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);
```
**Despite the name**, this table stores only the kiosk PIN (bcrypt). Portal authentication is entirely on `auth.users`. The table is locked down: `REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT ALL TO service_role` + RLS `employee_credentials_deny_all` returning false. Only SECURITY DEFINER RPCs touch it (`set_employee_kiosk_pin`, `attendance_kiosk_clock`).

## `employees → auth.users` linkage

- Column: `employees.user_id uuid` (nullable).
- Trigger `employees_sync_membership_aiu` (AFTER INSERT OR UPDATE) calls `employees_sync_membership()` — keeps `user_roles` in lockstep.
- Linkage events: invitation acceptance, admin manual link, and (only when allowed) `can_self_link` in `resolve_my_employee()`.
- `resolve_my_employee()` is the canonical resolver used by `useCurrentEmployee`. Returns `{is_linked, employee_id, organization_id, business_id, can_self_link}`; never raises (swallows errors for portal stability). `can_self_link` is `true` only when the caller is `owner/admin/super_admin` of an org with zero employees.

## Portal role & permissions

`user_roles.role='portal'` ↔ `user_type='portal'` is enforced by trigger `trg_enforce_role_user_type` (migration `20260213165006`). The default "Portal User" group seeded by `seed_default_permission_groups`:

| Module | read | create | write | delete |
|---|---|---|---|---|
| leave | ✅ | ✅* | ❌ | ❌ |
| timesheets | ✅ | ✅* | ❌ | ❌ |
| projects | ✅ | ❌ | ❌ | ❌ |

`*` Added by later migrations (`20260418074430`, `20260425123957`) for leave and timesheets.

Promotion to internal: RPC `promote_to_internal_user(p_user_id, p_org_id, p_new_role)` — caller must be `owner|admin|super_admin`.

## Portal routes (`/me/*`)

Shell: `src/apps/me/MeApp.tsx` wrapped by `<SelfServiceProvider>` + `<MePortalLayout>`. Mounted in `src/App.tsx:510`.

| Route | Component | Reads | Mutates |
|---|---|---|---|
| `/me` | `MeHome` | last 3 `payslips`, `useLeaveAllocations.getEmployeeBalances(id)` | — |
| `/me/profile` | `MyProfile` | Redirect to `/hr/employees/:id` via `resolve_my_employee()` | — |
| `/me/payslips` | `MyPayslips` | `payslips` + `payroll_runs` (own) | Download via `generate-payslip-pdf` |
| `/me/leave` | `MyLeave` | `useLeaveRequests/Types/Allocations` | INSERT `leave_requests` |
| `/me/attendance` | `MyAttendance` | `useMyAttendance`, `useAttendanceActions` | Clock-in/out, correction requests |
| `/me/timesheets` | `MyTimesheets` | Own timesheet rows | INSERT/UPDATE own entries |
| `/me/shifts` | `MyShifts` | Own roster | Shift swap requests |
| `/me/loans` | `MyLoans` | `useMyLoans` | INSERT `employee_loans(status='requested')`; UPDATE own requested → cancelled |
| `/me/documents` | `MyDocuments` | `useMyDocuments` | UPDATE via `acknowledge_employee_document` |
| `/me/onboarding` | `MyOnboarding` | Own onboarding tasks | Mark complete |
| `/me/exit` | `MyExitClearance` | Own exit progress | — |
| `/me/settings` | `MySettings` | `UserProfilePage` embed | name / phone / avatar |
| `/me/talent/*` | `MyTalent`, `MyGoals`, `MyReviewDetail` | `performance_goals`, `performance_reviews` | INSERT/UPDATE own goals; UPDATE reviewer submissions |
| `/me/learning/*` | `MyLearning`, `MyCatalog`, `MyPaths` | `training_enrollments`, `training_courses` | UPDATE enrollment progress |
| `/me/team` | `MyTeamPage` | Direct reports (`employee.manager_id=…`) | — |
| `/me/one-on-ones` | `MyOneOnOnes` | 1:1 records | Create/update own notes |

App-install gates:
- `/me/loans` requires `<AppInstalledGate appId="payroll">`.
- `/me/timesheets` requires the timesheets app installed (tile dimmed otherwise).

## PII masking

Migration `20260606192024_a4e1606a-…` introduced two pillars:

### `v_employees_safe` (security_invoker view)
Column-level CASE per tier:

| Tier | Columns | Visible when |
|---|---|---|
| Private PII | `national_id`, `date_of_birth`, `personal_phone`, `gender`, `marital_status`, address block, emergency contact | `e.user_id=auth.uid()` OR `user_can_view_employee_private(...)` |
| Payroll/Bank | `bank_name`, `bank_branch`, `bank_account_number`, `bank_code` | self OR `user_can_view_employee_payroll(...)` |
| Non-PII | id, employee_number, names, email, hire_date, employment_type, salary, avatar | every org member |

`user_can_view_employee_private` (SECURITY DEFINER, STABLE) → `super_admin|owner|admin|hr.delete|hr.write`.

Direct SELECT on the PII columns of the base `employees` table is REVOKED from `authenticated`. UI must use `v_employees_safe`.

### `get_employee_pii(p_employee_id uuid)`
SECURITY DEFINER. Gate: `v_is_self OR (v_can_private AND v_can_payroll)`. INSERTs `audit_logs(action='employee.pii.read', new_values={scope, fields})` before returning the JSONB payload. Granted to `authenticated`.

pgTAP coverage (`supabase/tests/employee_pii_masking_test.sql`): 6 assertions on view existence, authenticated read, raw column denial, function security definer, credentials denial.

## Separation-of-Duties (SoD)

Doc: `mem/features/sod-self-action.md` (Wave G2).

### Policy
`self_action_policy(organization_id, action_key, mode ∈ {block (default), warn, require_cosign, allow}, applies_to_role)`. Unique per `(org, action_key, applies_to_role)` and `(org, action_key)` WHERE role IS NULL. RLS: all org members can SELECT; only `owner|super_admin` can write.

### Overrides
`self_action_overrides(organization_id, actor_user_id, subject_user_id, action_key, reason, co_signed_by, expires_at, consumed_at)` — reason must be ≥ 12 chars, `co_signed_by ≠ actor`, default `expires_at = now() + 1h`. Immutable (trigger `trg_self_action_overrides_immutable`) unless `app.self_action_consume='true'`. RLS INSERT: `co_signed_by=auth.uid()` AND `owner|super_admin`.

### Enforcement
`governance_assert_not_self(actor, subject, action, org, entity_type, entity_id)` (SECURITY DEFINER, called from BEFORE UPDATE triggers):
1. Short-circuit if `actor ≠ subject` or teardown flag set.
2. Lookup actor's highest role.
3. Resolve `mode` (role-specific > default > `block`).
4. `allow` → return.
5. `warn` → audit log + return.
6. `block` / `require_cosign` → look up unexpired, unconsumed override; if found, mark consumed and return; otherwise raise SQLSTATE `42501` HINT `GOV_SELF_ACTION`.

Front-end `parseGovernanceError` interprets `42501` + HINT `GOV_SELF_ACTION | GOV_APPROVER_REQUIRED | GOV_MISSING_PERMISSION` and renders friendly errors.

### Surfaces covered
`sod_<table>_guard` BEFORE UPDATE triggers on:
`payroll_runs, leave_requests, timesheets, employee_loans, employee_contracts, compensation_reviews, bills, payments, journal_entries, purchase_orders, expenses, refunds, credit_notes (sales + vendor), stock_adjustments, stock_transfers`.

Coverage test `src/test/architecture/sod-coverage.test.ts` asserts every action in `selfActionCatalogue.ts` has a matching trigger.

## Portal RLS scoping (cheat sheet)

| Table | Policy | USING |
|---|---|---|
| `payslips` | `org_payslips_select` | `organization_id = ANY(get_user_organization_ids())` |
| `payslip_lines` | `payslip_lines_self_select` | `payslips.employee_id IN (employees WHERE user_id=auth.uid()) AND status IN ('approved','posted','paid')` |
| `payslip_inputs` | `payslip_inputs_self_select` | same as above |
| `employee_loans` | INSERT self request | `status='requested' AND employee_id IN (...) AND requested_by=auth.uid()` |
| `employee_loans` | UPDATE self request | `status='requested' AND employee_id IN (...)` → only `requested → cancelled` |
| `performance_goals` | `pgoal write self or hr` | self OR `user_has_module_permission(..., 'write')` |
| `training_enrollments` | `enrol self update progress` | `employee_id IN (...)` |
| `employees` | `org_employees_select` | org-scoped; PII columns column-REVOKED |
| `v_employees_safe` | view-level CASE | per PII tier |

## Architecture invariants (tests)

- `invitation-no-tabs.test.ts`
- `portal-identity-invariants.test.ts` — `v_identity_invariants_violations` returns 0
- `portal-payslip-contract.test.ts`
- `sod-coverage.test.ts`
- `supabase/tests/employee_pii_masking_test.sql`
- `supabase/tests/self_action_guard_test.sql`

> Full evidence: `./_research/06-employee-portal.md`.
