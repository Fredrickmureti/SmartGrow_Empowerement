---
name: ESS identity portal — completion status
description: Employee Self-Service /me/* portal audit. Ownership boundaries enforced in DB; HR review queue live; bank-change payroll lock; shell-leak lint + arch test.
type: feature
---

# ESS identity portal — enterprise ownership model

## Ownership matrix (enforced in DB, not just UI)
- HR-owned (change request required): `first_name`, `last_name`, `national_id`, `date_of_birth`, `gender`, `bank_name`, `bank_branch`, `bank_account_number`, `bank_code`.
- Employee-managed (direct RPC): `personal_phone`, `phone`, `address_*`, `emergency_contact_*`, `marital_status`, `avatar_url`.
- Identity-owned (Supabase auth): email (read-only, verification required to change), password (self-service via `supabase.auth.updateUser` + reset link).
- System-owned: `employee_number`, `hire_date`, `lifecycle_status`, `employment_type`.

## Backend
- Table `employee_profile_change_requests` — WITH CHECK (false) on INSERT; RLS: self-select + HR-select; employee may cancel own pending.
- View `v_my_employee_profile` — security invoker, masks `national_id` / `bank_account_number`.
- RPCs: `update_own_employee_personal(jsonb)` (whitelist), `submit_profile_change_request(field,value,reason)` (HR-field whitelist + bank-change payroll lock: blocks when any payslip's payroll_run is in draft/calculating/review/approved), `review_profile_change_request(id,decision,note)` (role-gated; applies whitelisted diff to `employees`).
- login_history already has "Users can view own login history" policy — surfaced on `/me/account`.

## UI surfaces
- `/me/profile` — HR record (read-only) + Personal + Emergency + Bank/IDs (masked) + "My change requests" strip with cancel.
- `/me/account` — sign-in email, password (self-service), theme, sign-out, **Recent sign-in activity** (last 10 from login_history).
- `/me/notifications` — inside portal shell (no more exit to `/notifications`).
- `/hr/employees/change-requests` — HR review queue with approve/reject + note; toolbar badge on `/hr/employees` shows pending count (60s poll).

## Guardrails
- ESLint rule `no-shell-leak-from-me` — flags `<Link to="/hr/…" | "/settings/…" | "/notifications">` and `navigate("/hr/…")` calls inside `src/pages/me/**` or `src/apps/me/**`. Allowlist: `/hr/talent/reviews`, `/hr/talent/development` (manager drill-downs).
- Arch test `src/test/architecture/ess-portal-shell.test.ts` — filesystem sweep companion (CI-cache-resilient).
- `/hr/MyProfile.tsx` is a redirect-only shim to `/me/profile` — closes the original `/hr/employees/:id` → portal-guard bounce.

## Explicitly deferred (not in current plan)
- pgTAP test for the new RPCs — smoke tests should be added when a Supabase pgTAP runner is wired in.
- MFA/TOTP enrollment on `/me/account` — needs QR + verify UX; separate ticket.
- Sign-in email change flow with verification.
