# Signup / email-confirmation lifecycle — audit verdict

_Last updated: 2026-05-17 — opened after `masindecare@gmail.com` hit
"Invalid login credentials" after clicking a confirmation email._

## TL;DR

The platform's signup → email-confirmation → session-establishment chain
is correct in the happy path. The dead-end users hit ("Invalid login
credentials" after clicking the confirmation email) is caused by **stale
confirmation links left in inboxes after the user self-reaps their
orphaned account** via the "Start over with this email" recovery flow.

Mitigation: a new `/auth/callback` page now classifies invalid-token
outcomes against `signup_cleanup_log` and shows actionable copy ("sign up
again") instead of bouncing to `/login` where the user sees a generic
credentials error.

## Forensic trace for `masindecare@gmail.com`

| Time (UTC, 2026-05-17) | Event |
|---|---|
| 12:24:07 | `signup_cleanup_log` row inserted: `manual_reset_orphan_identity` |
| 12:24:09 | `signup_cleanup_log` row inserted: `self_reap_orphan_identity` |
| (later)  | User clicks confirmation email → `setSession()` fails (user_id no longer exists) → bounced to `/login` → manual login fails with `Invalid login credentials` |
| (later)  | User clicks **Forgot password** → Supabase anti-enumeration returns success without sending an email (no auth row to recover) |

`auth.users` currently has **no row** for `masindecare@gmail.com`, no
`profiles` row, no `organization_invitations` row. The email is therefore
free to reuse — the user simply needs to redo `/signup`.

## Failure modes inventory

1. **Stale confirmation link after self-reap** — fixed by `/auth/callback`
   + `was-email-reaped` edge function. Users now see:
   > "This link is no longer valid because you reset your signup. Please
   > sign up again."
2. **Stale confirmation link without a self-reap** — Supabase token TTL
   exceeded. Users now see:
   > "This confirmation link has expired. Send me a new link."
3. **`resetPasswordForEmail` silently succeeds for non-existent emails**
   — Supabase's anti-enumeration default. We keep the security-correct
   generic success message but now layer a contextual hint when
   `was-email-reaped` returns true:
   > "Heads up: you previously chose Start over with this email, which
   > removed your account. No reset email will arrive — please sign up
   > again."
4. **Flow drift** — the email confirmation pages parse hash tokens
   (implicit flow). A future change to PKCE without updating these pages
   would silently break confirmation. Pinned in
   `src/integrations/supabase/client.ts` and asserted by
   `src/test/architecture/supabase-client-auth-config.test.ts`.

## Contract — `/auth/callback`

`SignupForm` now sets `emailRedirectTo = "${origin}/auth/callback"`. The
callback page handles three URL shapes:

- `#access_token=…&refresh_token=…&type=signup` — implicit flow (current
  default).
- `?code=…` — PKCE flow (forward-compatible).
- `#error=…&error_description=…` — Supabase already rejected the token.

Decision tree on token failure:

```
token invalid
  └── decode email from JWT payload (best effort)
      └── call was-email-reaped(email)
          ├── reaped=true  → "sign up again" UI → /signup
          └── reaped=false → "link expired"   UI → /verify-email
```

`/onboarding-setup` keeps its legacy hash handler as a fallback for
confirmation emails already in user inboxes that point at the old
redirect target. On `setSession` failure it now delegates to
`/auth/callback` with the original hash so users get the same actionable
copy regardless of which URL the email points at.

## Anti-enumeration notes

`was-email-reaped` only returns `true` for emails the user themselves
chose to remove via the in-app "Start over" recovery flow (or that an
admin manually reaped). An attacker cannot induce this state for an
arbitrary email they do not control, so the endpoint does not enable
enumeration of which addresses ever held accounts. It is additionally
rate-limited to 10 requests / minute / IP.

## What was NOT changed

- Email confirmation is **not** disabled.
- `resetPasswordForEmail` still returns the security-correct generic
  success message — we only add a non-blocking hint when reap evidence is
  available.
- No bypasses of token validation, no hand-crafted sessions, no admin
  endpoints exposed to clients.
- `check-email-availability` and `self-reap-orphan-identity` retain their
  existing heuristics — the new work is purely about surfacing the
  consequences of those heuristics to the user.

## Files touched

- New: `src/pages/AuthCallback.tsx`
- New: `supabase/functions/was-email-reaped/index.ts`
- New: `src/test/architecture/supabase-client-auth-config.test.ts`
- New: `docs/audit/signup-lifecycle-verdict.md` (this file)
- Edit: `src/components/auth/SignupForm.tsx` — redirect target
- Edit: `src/components/auth/OnboardingGate.tsx` — public-prefix list
- Edit: `src/pages/OnboardingSetup.tsx` — stale-token delegation
- Edit: `src/pages/ForgotPassword.tsx` — reap hint
- Edit: `src/integrations/supabase/client.ts` — pinned flow options
- Edit: `src/App.tsx` — register `/auth/callback`
- Edit: `supabase/config.toml` — `verify_jwt = false` for the new function

## Deployment note

`supabase/functions/was-email-reaped/` is committed but not yet deployed —
the project hit its edge-function quota cap at the time of this audit.
Until it is deployed, `/auth/callback` and `/forgot-password` degrade
gracefully: invalid-token outcomes show the generic "link expired" copy
(with a button to request a fresh link) rather than the previous silent
"Invalid login credentials" dead-end. After the quota is raised, deploy
the function and the post-reap hint will start surfacing automatically —
no further code changes required.