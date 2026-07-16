# Complete remaining ESS identity work — MFA enforcement at login

## Audit result

I verified the previous agent's claims against the repo:

- Migration RPCs (`log_identity_email_change_intent`, `record_mfa_lifecycle_event`), lifecycle events (`identity_email_change_requested`, `mfa_enrolled`, `mfa_unenrolled`), and `work_email` whitelist — reflected in `mem/features/ess-identity-portal.md`.
- `/me/account` cards `EmailChangeCard` and `MfaEnrollmentCard` exist (`src/components/me/MfaEnrollmentCard.tsx` present).
- HR queue `work_email` label — in `EmployeeChangeRequestsPage`.
- pgTAP test file `supabase/tests/employee_profile_change_requests_test.sql` present.
- ESLint `no-shell-leak-from-me`, arch test, `/hr/MyProfile.tsx` redirect shim — all present.

**Only remaining item from the previous plan:** MFA enforcement at login. `EnhancedLoginForm` and `Login.tsx` have zero references to `mfa`, `aal`, or `challenge`. Users can enroll TOTP on `/me/account` but the login flow never challenges them, so AAL stays at `aal1` and enrolled 2FA is decorative.

## What to build

An AAL2 gate that runs after a successful password/PIN sign-in, before the app admits the user into `/me/*` or `/hr/*`.

### 1. Post-login MFA challenge component

New `src/components/auth/MfaChallengeGate.tsx`:

- On mount, call `supabase.auth.mfa.listFactors()`.
- If the user has any `verified` TOTP factor AND `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` returns `{ currentLevel: 'aal1', nextLevel: 'aal2' }`, render a 6-digit code form.
- Submit → `mfa.challenge({ factorId })` then `mfa.verify({ factorId, challengeId, code })`. On success, resolve gate.
- Provide a "Sign out" escape hatch (no bypass — if user cannot produce a code, they must contact HR admin to reset, matching the documented recovery posture).
- Error surfaces use existing toast primitive; no raw error messages.

### 2. Wire the gate into the app shell

In `src/App.tsx` (or the nearest authenticated boundary that already wraps `/me/*` and `/hr/*`):

- After the existing session check, before rendering protected routes, evaluate AAL.
- If `currentLevel === 'aal1'` and a verified factor exists → render `<MfaChallengeGate />` instead of the routed children.
- Once verified (session upgraded to aal2), render children normally.
- Public routes (`/login`, `/auth/*`, `/reset-password`) bypass the gate.

This avoids touching `EnhancedLoginForm` / `PINLoginForm` directly (per the deferred-note guidance about not destabilising the PIN-aware login), and cleanly covers both entry paths plus session restoration on refresh.

### 3. Admin login parity

`AdminInlineMfaSetup` / `AdminMfaStatus` already exist for admin enrollment. Reuse the same `MfaChallengeGate` for `AdminProtectedRoute` so admin sessions also require AAL2 when a factor is enrolled. No new admin-specific challenge UI.

### 4. Audit + memory

- No new DB migration needed — Supabase owns `auth.mfa_*` and lifecycle audit already fires from `record_mfa_lifecycle_event` on enroll/unenroll. A successful challenge does not need a lifecycle event (it's a routine sign-in), but we will append it to `login_history` if the existing sign-in path already writes there; otherwise skip to avoid scope creep.
- Update `mem/features/ess-identity-portal.md`: move the MFA-enforcement bullet out of "Deferred" into the shipped section, referencing `MfaChallengeGate`.

## Out of scope

- Custom recovery-code storage (remains HR-admin reset, per prior decision).
- WebAuthn / passkeys.
- Forcing enrollment for privileged roles — enforcement only fires when a factor is already verified.

## Files touched

- **New:** `src/components/auth/MfaChallengeGate.tsx`
- **Edit:** `src/App.tsx` (or the current authenticated shell) — insert gate
- **Edit:** `src/components/auth/AdminProtectedRoute.tsx` — reuse gate
- **Edit:** `mem/features/ess-identity-portal.md` — move item out of Deferred

## Verification

- Typecheck clean.
- Manual: enroll TOTP on `/me/account`, sign out, sign back in → challenge appears; correct code → lands on `/me`; wrong code → error, no session upgrade; sign-out escape works.
- User without a verified factor sees no change (gate short-circuits).
