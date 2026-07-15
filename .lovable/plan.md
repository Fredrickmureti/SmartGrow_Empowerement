
## Context

The previous agent shipped most of the ESS identity/profile/account overhaul (ownership matrix, `v_my_employee_profile`, three change-request RPCs, HR review queue with pending badge, "My change requests" strip, sign-in activity card, in-shell `/me/notifications`, ESLint `no-shell-leak-from-me`, arch test, memory note). Spot check confirms the pages, routes, and migrations are on disk. I'm treating that as unverified until each item is independently checked in code and at runtime.

## Phase 1 — Verification audit (no code changes)

For each claimed deliverable, confirm it exists, is wired, and behaves right. Anything failing a check drops into Phase 2.

1. **Routing / "Profile bounces back to /me" bug**
   - Confirm `/me/profile` mounts `MyProfilePage` (done: `MeApp.tsx` line 85–92, `App.tsx` line 555).
   - Drive Playwright through sign-in → click Profile → assert URL stays on `/me/profile` and the HR record card renders. Capture screenshot.
   - If it still bounces, trace `MePortalLayout`, `PortalUserRoute`, `SubscriptionProtectedRoute`, and any legacy `/hr/MyProfile` redirect shim for the root cause (not a patch).

2. **Ownership boundaries enforced in DB**
   - Read the two new migrations end-to-end. Verify: `employee_profile_change_requests` table + RLS (self insert-blocked, self+HR select, self cancel pending); `v_my_employee_profile` is `security_invoker` and masks `national_id` / `bank_account_number`; `update_own_employee_personal` whitelist matches ownership matrix; `submit_profile_change_request` HR-field whitelist + payroll lock condition (draft/calculating/review/approved); `review_profile_change_request` is role-gated and writes only whitelisted diffs.
   - Cross-check GRANTs exist for every new table/view/function per repo rules.

3. **HR review surface**
   - `/hr/employees/change-requests` renders queue, approve/reject with note works, badge on `/hr/employees` polls 60s.

4. **ESS surfaces**
   - `/me/profile`: HR read-only, Personal editable, Emergency editable, Bank/IDs masked with change-request CTA, My-requests strip with cancel.
   - `/me/account`: sign-in email read-only, password self-service via `supabase.auth.updateUser` + reset link, theme, sign-out, Recent sign-in activity from `login_history`.
   - `/me/notifications`: renders inside `MePortalLayout` (no shell exit).

5. **Guardrails**
   - `eslint-rules/no-shell-leak-from-me.js` is registered in the ESLint config (verify — a rule file with no config entry is dead).
   - `src/test/architecture/ess-portal-shell.test.ts` runs green.
   - `mem/features/ess-identity-portal.md` matches shipped reality.

## Phase 2 — Gaps to close

Only items I already expect to find, based on the handoff + a first-pass read:

1. **ESLint registration** — if the plugin/rule is not wired into `eslint.config` / `.eslintrc`, register it so the guardrail actually runs in CI.
2. **Email-change flow** — memory explicitly defers this, but the audit brief calls it out. Add a self-service "Request email change" that (a) triggers Supabase email-change verification for the identity email, and (b) opens an HR change-request for `work_email` when they differ. Read-only until then.
3. **Profile-change lifecycle events** — approvals/rejections should emit into `employee_lifecycle_events` (matches the pattern used by identity RPCs) so HR has a durable audit trail beyond the request row.
4. **HR notification on submit** — when `submit_profile_change_request` inserts a pending row, enqueue a notification to users with the HR reviewer role (reuse existing notifications table; no new channel).
5. **Manager notification on bank-change approval** — payroll-sensitive; also record who approved on the request row (already there) and surface it in the strip.
6. **Portal shell continuity sweep** — grep `src/pages/me/**` + `src/apps/me/**` for any remaining `<Link to="/hr/…">` / `navigate("/settings…")` / `/notifications` that the ESLint rule would flag; fix in-place by routing within `/me/*` or extending the allowlist with justification.
7. **`MySettings` hub** — keep as-is (thin index) but confirm no page still deep-links to `/me/settings` expecting the old inline editor.
8. **pgTAP smoke tests for the three new RPCs** — deferred in memory. Add minimal shape tests (function exists, SECURITY DEFINER where expected, RLS present) alongside `employee_pii_masking_test.sql`; skip behavioural tests until a runner is wired.

Anything Phase 1 turns up as broken or shallow gets appended here before implementation starts.

## Phase 3 — Implementation order

1. Fix any Phase 1 regression first (routing bounce is highest priority if reproduced).
2. Register ESLint rule + run repo-wide, fix violations.
3. Notification wiring (submit + review) — small, high leverage.
4. Lifecycle-event emissions in the two review RPCs (single migration).
5. Email-change flow (RPC + `/me/account` UI + HR reviewer surface reuse).
6. pgTAP shape tests.
7. Update `mem/features/ess-identity-portal.md` to reflect the new state and drop the "deferred" entries that are now shipped.

## Out of scope (explicit)

- MFA/TOTP enrollment — separate ticket per memory.
- Visual redesign of `/me/*` beyond what's needed to keep the shell coherent. The audit brief allows redesign, but the current shell already reads as one product; I won't rip it up without a concrete inconsistency to point at.
- Any change to `/hr/*` admin shells beyond the change-request queue that already exists.

## Deliverable

A verified, gap-closed ESS identity experience where every profile field has a documented owner, every mutation path (self-edit, change request, HR review, email change) emits an audit trail, HR is notified on submission, and the portal shell never punches the employee into an admin surface. Memory file updated to match.
