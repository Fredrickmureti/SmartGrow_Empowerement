---
name: ESS identity portal — completion status
description: Employee Self-Service /me/* portal audit. Ownership boundaries enforced in DB; HR review queue live; bank-change payroll lock; shell-leak lint + arch test; self-service email change + MFA/TOTP.
type: feature
---

# ESS identity portal — enterprise ownership model

## Ownership matrix (enforced in DB, not just UI)
- HR-owned (change request required): `first_name`, `last_name`, `national_id`, `date_of_birth`, `gender`, `bank_name`, `bank_branch`, `bank_account_number`, `bank_code`, `work_email`.
- Employee-managed (direct RPC): `personal_phone`, `phone`, `address_*`, `emergency_contact_*`, `marital_status`, `avatar_url`.
- Identity-owned (Supabase auth): email (self-service via `supabase.auth.updateUser`, double-opt-in), password (self-service + reset link), TOTP two-step verification (self-service enroll/unenroll).
- System-owned: `employee_number`, `hire_date`, `lifecycle_status`, `employment_type`.

## Backend
- Table `employee_profile_change_requests` — WITH CHECK (false) on INSERT; RLS: self-select + HR-select; employee may cancel own pending.
- View `v_my_employee_profile` — security invoker, masks `national_id` / `bank_account_number`.
- RPCs:
  - `update_own_employee_personal(jsonb)` — whitelist for employee-managed fields.
  - `submit_profile_change_request(field,value,reason)` — HR-field whitelist (now including `work_email`) + bank-change payroll lock (blocks when any payslip's payroll_run is in draft/calculating/review/approved) + emits `profile_change_requested` + fanout to HR admins via `notifications`.
  - `review_profile_change_request(id,decision,note)` — role-gated; applies whitelisted diff to `employees`; emits `profile_change_approved`/`profile_change_rejected`; notifies the requesting employee.
  - `log_identity_email_change_intent(new_email, reason)` — called by `/me/account` before `supabase.auth.updateUser({ email })`; emits `identity_email_change_requested` + notifies HR admins.
  - `record_mfa_lifecycle_event(action, factor_type)` — audit-only write for `mfa_enrolled`/`mfa_unenrolled` (Supabase owns the actual `auth.mfa_*` factors).
- login_history already has "Users can view own login history" policy — surfaced on `/me/account`.

## UI surfaces
- `/me/profile` — HR record (read-only) + Personal + Emergency + Bank/IDs (masked) + "My change requests" strip with cancel.
- `/me/account` — self-service:
  - **Change sign-in email** (`EmailChangeCard`): fires Supabase double-opt-in and optionally opens an HR `work_email` change request so records stay aligned.
  - **Password** (self-service + email-reset).
  - **Two-step verification** (`MfaEnrollmentCard`): TOTP enroll (QR + secret + verify code), unenroll with confirm. Recovery-code recovery is via HR admin reset — no custom code table.
  - Theme, sign out, **Recent sign-in activity** (last 10 from login_history).
- `/me/notifications` — inside portal shell.
- `/hr/employees/change-requests` — HR review queue with approve/reject + note; `work_email` label added; toolbar badge on `/hr/employees` shows pending count (60s poll).

## Guardrails
- ESLint rule `no-shell-leak-from-me` — `export default` (ESM) so it registers in `eslint.config.js`. Allowlist: `/hr/talent/reviews`, `/hr/talent/development`.
- Arch test `src/test/architecture/ess-portal-shell.test.ts` — filesystem sweep companion.
- `/hr/MyProfile.tsx` is a redirect-only shim to `/me/profile`.
- pgTAP shape test `supabase/tests/employee_profile_change_requests_test.sql` — asserts the change-request table + RLS + masked view + RPC signatures + lifecycle-event emits.

## Audit trail & notifications
- Lifecycle event types on `employee_lifecycle_event_type`: `profile_change_requested`, `profile_change_approved`, `profile_change_rejected`, `identity_email_change_requested`, `mfa_enrolled`, `mfa_unenrolled`.
- `submit_profile_change_request` and `log_identity_email_change_intent` fan out to every admin/super_admin/owner via `notifications`.
- `review_profile_change_request` notifies the requesting employee (if user-linked), linking back to `/me/profile`.

## Deferred (not currently built)
- MFA enforcement at login: enrollment surface ships, but the login form does not yet auto-challenge for verified factors. Follow-up should extend `EnhancedLoginForm` (or add a post-session guard) to require AAL2 before entering `/me/*` or `/hr/*` when a verified factor exists.
- Custom recovery-code storage — deferred; lost devices are reset by HR admin.
