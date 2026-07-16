
# ESS identity portal — verification + deferred items

## Phase 1 — Independent verification (no code changes)

Audit every claim in `mem/features/ess-identity-portal.md` against the codebase and runtime. Anything that fails drops into Phase 2 before the new work starts.

1. **Routing bounce killed** — Playwright: sign in → click Profile → assert URL sticks on `/me/profile` and the HR card renders. Confirm `/hr/MyProfile` is a redirect-only shim.
2. **DB ownership boundaries** — read both change-request migrations end-to-end. Verify:
   - `employee_profile_change_requests`: `WITH CHECK (false)` on direct INSERT, RLS (self+HR select, self cancel pending), GRANTs.
   - `v_my_employee_profile`: `security_invoker`, masks `national_id` + `bank_account_number`.
   - `update_own_employee_personal`: whitelist matches ownership matrix.
   - `submit_profile_change_request`: HR-field whitelist + bank payroll lock (draft/calculating/review/approved) + emits `profile_change_requested` + HR notification fanout.
   - `review_profile_change_request`: role-gated, whitelisted diff, emits approved/rejected lifecycle event + notifies employee.
3. **HR review surface** — `/hr/employees/change-requests` approve/reject/notes; 60s pending badge on `/hr/employees`.
4. **ESS surfaces** — `/me/profile` (HR read-only, Personal/Emergency editable, Bank/IDs masked + CTA, My-requests strip with cancel); `/me/account` (email read-only, password self-service, theme, sign-out, sign-in activity); `/me/notifications` renders inside `MePortalLayout`.
5. **Guardrails** — `no-shell-leak-from-me` registered in `eslint.config.js` and passes repo-wide; `src/test/architecture/ess-portal-shell.test.ts` green; memory doc matches reality.

Report deltas before writing code. Any gap becomes a Phase 2 item.

## Phase 2 — Deferred items (implement)

### A. Self-service email change

Business event: employee changes their sign-in email. Two systems are affected — Supabase auth (identity) and `employees.work_email` (HR). They must stay decoupled: auth email flips only after Supabase's own double-confirm; the HR field only flips after HR approval.

- DB: extend `employee_profile_change_requests.field_name` whitelist to include `work_email`; add optional `identity_email_change_requested_at` column on the request row for the audit trail. New RPC `request_identity_email_change(new_email text)` wraps `supabase.auth.updateUser({ email })` server-side reasoning: emit `identity_email_change_requested` lifecycle event + notification to HR admins. (Actual email verification stays client-side via `supabase.auth.updateUser` since that's the only path that sends Supabase's verification mail; the RPC just logs intent + fans out notifications.)
- Client: `/me/account` — new "Change sign-in email" card. Two-step:
  1. `supabase.auth.updateUser({ email: newEmail })` → tell user to confirm both mailboxes.
  2. If `newEmail !== employee.work_email`, call `submit_profile_change_request('work_email', newEmail, reason)` so HR reviews the payroll/records-side change independently.
- HR: existing `/hr/employees/change-requests` queue already handles it — add `work_email` to the field label map + reviewer copy.
- Guard: block the flow while the account has an unconfirmed pending email change (`supabase.auth.getUser()` exposes `new_email`); show pending banner + resend/cancel.

### B. MFA / TOTP enrollment on `/me/account`

Pure Supabase Auth MFA (no schema changes; `auth.mfa_*` is managed).
- New "Two-step verification" card on `/me/account`:
  - List factors (`supabase.auth.mfa.listFactors()`).
  - Enroll: `mfa.enroll({ factorType: 'totp' })` → render QR (`totp.qr_code`) + manual secret → `mfa.challenge` + `mfa.verify` with 6-digit code → success toast + refresh factors.
  - Unenroll: `mfa.unenroll({ factorId })` behind a confirm dialog.
  - Recovery codes: Supabase doesn't mint them natively; show explanatory copy that admins can reset via HR if the device is lost (matches current "contact admin" posture). No custom recovery-code table.
- Auth flow: extend login step to call `mfa.challenge` + prompt for code when `assuranceLevel === 'aal1' && nextLevel === 'aal2'`. Route unchanged; the login form handles the extra step.
- Lifecycle: emit `mfa_enrolled` / `mfa_unenrolled` into `employee_lifecycle_events` via a small RPC `record_mfa_lifecycle_event(action text)` so HR has an audit trail (Supabase's own `auth.audit_log_entries` is not queryable from the app).
- Enum: add `mfa_enrolled`, `mfa_unenrolled` to `employee_lifecycle_event_type`.

### C. pgTAP shape tests for the three change-request RPCs

New `supabase/tests/employee_profile_change_requests_test.sql` — schema-shape only, matches the style of `employee_pii_masking_test.sql`:
- `employee_profile_change_requests` exists, RLS enabled, expected policies present.
- `v_my_employee_profile` exists, is a view, `security_invoker=true`, masks the two PII columns.
- Each RPC exists with expected signature; `submit_profile_change_request` + `review_profile_change_request` are SECURITY DEFINER; `update_own_employee_personal` is SECURITY INVOKER.
- RPC bodies contain the expected lifecycle event emits (`profile_change_requested/approved/rejected`) and HR-notification fanout, mirroring the pattern already used in `employee_identity_events_test.sql`.
- Extend `employee_identity_events_test.sql` (or add a sibling) to assert the two new enum values for MFA and the `identity_email_change_requested` event.

## Phase 3 — Memory + docs

- Update `mem/features/ess-identity-portal.md`: drop the three "deferred" bullets, add: email-change flow (identity + HR halves), MFA enrollment surface + login step, new lifecycle events, pgTAP shape tests.
- No ADR needed — this stays inside the existing ESS identity ownership model.

## Out of scope

- Rewriting `/me/*` visual design beyond what the new cards need.
- Any change to `/hr/*` beyond adding `work_email` to the reviewer field labels.
- SSO / external IdP integration.
- Custom recovery-code storage (defer until users actually ask).

## Technical notes

- Email-change: Supabase's `updateUser({ email })` requires double-opt-in — new address must confirm and (by default) old address must confirm too. Keep that default on.
- MFA verify at login: `signInWithPassword` returns `aal1`; call `mfa.listFactors()` and if a verified TOTP factor exists, force `mfa.challenge` before treating the session as authenticated. Guard in the auth callback so `/me/*` and `/hr/*` layouts don't render pre-`aal2`.
- Enum additions: single migration, `ALTER TYPE ... ADD VALUE IF NOT EXISTS` for each of `mfa_enrolled`, `mfa_unenrolled`, `identity_email_change_requested`.
- All new RPCs: `SECURITY DEFINER`, `SET search_path = public`, GRANT EXECUTE to `authenticated` only.
- pgTAP file lives under `supabase/tests/` and follows the `BEGIN; SELECT plan(N); ... ROLLBACK;` shape already established.
