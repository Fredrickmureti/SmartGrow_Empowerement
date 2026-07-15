
# ESS Identity Portal — Verify & Complete

I audited what the previous agent shipped before proposing new work. Below is what I verified, what needs deeper verification, and the concrete gaps to close.

## What I verified is in place

- **Routing root cause fixed**: `src/pages/hr/MyProfile.tsx` is now a `<Navigate to="/me/profile" replace />` shim, ending the `/hr/employees/:id` → portal-guard → `/me` bounce.
- **Portal-native pages exist and are wired in `src/apps/me/MeApp.tsx`**: `/me/profile` (`MyProfilePage.tsx`, 419 lines), `/me/account` (`MyAccount.tsx`, 185 lines, real `supabase.auth.updateUser` + reset link), `/me/notifications` (`MyNotifications.tsx`, 146 lines), `/me/settings` (thin index).
- **Portal nav** (`MePortalLayout.tsx`) has an Account group with Profile · Account · Notifications; user menu points to `/me/profile` and `/me/account`.
- **Backend migration** `20260715231920_…sql` creates `employee_profile_change_requests` with proper GRANTs + RLS (self-select, HR-select, block-direct-insert, cancel-own), `v_my_employee_profile` (security invoker, masked national_id + bank), and three RPCs: `update_own_employee_personal(jsonb)` (whitelist), `submit_profile_change_request(field,value,reason)` (HR-field whitelist), `review_profile_change_request(id,decision,note)` (role-gated, applies diff on approve). Ownership matrix is enforced in the DB, not just the UI.

## Verification pass (before writing new code)

Fast, read-only sweep — no fixes yet unless a real regression is found:

1. Re-read `MyProfilePage.tsx`, `MyAccount.tsx`, `MyNotifications.tsx` end-to-end for: correct RPC arg names, cache-invalidation on mutate, empty/loading/`EmployeeLinkRequired` fallback, no admin-only widgets leaking in.
2. Grep for any surviving `/me/*` → `/notifications`, `/hr/*`, `/settings/*` links (NotificationPopover "View all", user menus, deep links from widgets) — confirm they route within `/me/*` when `useSelfService()` is true.
3. Confirm the migration matches the runtime schema (columns used by view exist on `employees`; `has_role` signature matches the project's enum).
4. Confirm `update_own_employee_personal` cannot silently touch HR fields (whitelist loop happens before UPDATE — verified visually; will add a pgTAP test below).
5. Confirm `review_profile_change_request`'s dynamic UPDATE only accepts keys that were whitelisted at submit time (double-checked: submit RPC gates on `v_hr_fields`, review RPC then trusts row → safe as long as no other path can insert; RLS `WITH CHECK (false)` on INSERT enforces this).

Anything broken found in this pass gets folded into step 1 below before shipping new surfaces.

## Gaps to close (previous agent explicitly deferred)

### 1. HR admin review queue
New route `/hr/employees/change-requests` (admin shell):
- List pending `employee_profile_change_requests` for the current org with employee name, field, old → new diff, reason, requested_at.
- Approve / Reject actions call `review_profile_change_request` RPC.
- Filter by status; default = pending. Empty state.
- Link from `/hr/employees` toolbar with a pending-count badge (single count query).

### 2. Employee's own "My change requests" strip
On `/me/profile`, small card listing the employee's own pending requests with cancel action (RLS already permits status→cancelled). Closes the loop so users see their submission's state.

### 3. Bank-change payroll lock
`submit_profile_change_request` should reject bank_* field submissions while the employee has any payroll run in states {`draft`,`calculating`,`review`,`approved`} in the current period. Enforced in the RPC (single `EXISTS` check) with a clear `ERRCODE` + message; UI surfaces the message via toast.

### 4. MFA & recent login history on `/me/account`
- **MFA**: Enroll/unenroll TOTP factor via `supabase.auth.mfa.*`. Show current factor state; QR + verify flow behind a dialog.
- **Login history**: Read from existing `login_history` table (already present, see `<supabase-tables>`) — last 10 sessions with device/ip/timestamp; RLS assumed scoped to `user_id`; verify and add owner-select policy if missing.

### 5. Architectural guardrails
- **pgTAP** `supabase/tests/ess_profile_rpcs_test.sql`: asserts (a) `update_own_employee_personal` rejects HR keys, (b) `submit_profile_change_request` rejects non-HR keys, (c) non-admin cannot call `review_profile_change_request`, (d) RLS blocks direct INSERT into `employee_profile_change_requests`, (e) view masks `national_id` / `bank_account_number`.
- **ESLint rule** `eslint-rules/no-shell-leak-from-me.js`: inside files under `src/pages/me/**` or `src/apps/me/**`, flag `<Link to="/hr/…">`, `<Link to="/settings/…">`, `<Link to="/notifications">`, and equivalent `navigate("/hr/…")` calls. Register in `eslint.config.js` with an allowlist file for genuine cross-shell links (e.g. sign-out).
- **Arch test** `src/test/architecture/ess-portal-shell.test.ts`: greps `src/pages/me/**` for the same patterns as a fast belt-and-braces check the ESLint rule can't miss during CI cache skips.

## Explicitly out of scope

- Restyling any page beyond what the gaps above require. The previous agent's ownership-labeled card layout stays.
- Rewriting other `/me/*` pages (payslips, leave, timesheets) — those already live under `MePortalLayout` and use `SelfServiceContext`.
- Payroll domain changes beyond the read-only "is there an open run?" check in the bank-lock RPC.

## Technical details

- Migration order: add bank-payroll-lock branch inside `submit_profile_change_request` in a new migration (do not edit the existing one); pgTAP file added alongside. New migration also adds any missing SELECT policy on `login_history` for own rows.
- HR queue reads via `requireSupabaseAuth` context so RLS applies (HR-select policy already permits it); mutations go through the RPC.
- New route file `src/routes/hr.employees.change-requests.tsx` (dot convention already used in project). Registered inside the existing admin shell — no new layout.
- `/me/account` MFA + login history live in the same file; no new page.
- ESLint rule is a standard AST rule matching `JSXAttribute[name.name="to"]` string literals + `CallExpression[callee.name="navigate"]` first-arg literals; parallels existing rules like `no-hand-rolled-me-header.js`.

## Sequencing

1. Verification sweep (read-only) — fold any real regressions into step 2.
2. Migration: bank-lock + login_history policy + pgTAP file.
3. HR review queue route + toolbar badge.
4. `/me/profile` "My change requests" strip.
5. `/me/account` MFA + login history sections.
6. ESLint rule + arch test + docs update in `mem/features/`.

I'll pause after step 1 only if the verification pass turns up a real regression that changes the plan; otherwise I proceed straight through.
