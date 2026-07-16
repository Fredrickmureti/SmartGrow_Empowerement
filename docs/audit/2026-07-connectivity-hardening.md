# 2026-07 Connectivity Hardening Audit

## Reported symptom

Brief internet interruptions during app load transitioned the app into a
fatal "We couldn't load your workspace" state that did not recover when
connectivity returned. Users had to hard-refresh.

## Root cause (evidence)

- `src/contexts/SessionContext.tsx` — the session bootstrap RPC
  (`get_user_session_data`) ran in a fixed 3-attempt loop with no
  exponential backoff, no connectivity awareness, and — critically — no
  subscription to `ConnectivityManager`. Once the budget was exhausted,
  the terminal state was permanent regardless of subsequent
  connectivity recovery.
- `src/components/common/SessionFailureCard.tsx` — the UI presented every
  failure with destructive iconography and copy, indistinguishable from a
  genuine unrecoverable error.
- Recovery infra existed (`ConnectivityManager`, `ErrorNormalizer`,
  `supabaseSafe`, `ConnectivityBanner`) but was not wired into the session
  bootstrap path.

## Changes shipped in this pass

- `SessionContext.fetchSessionData` — routed through `safeRpc`, 6 attempts
  with jittered exp-backoff `[0, 500, 1500, 4000, 8000, 15000] ms`, parks
  on offline, one-shot `refreshSession()` on `auth_expired` without
  consuming a retry slot, fails fast on deterministic kinds, overlapping
  loops guarded by `inflightBootstrapRef` + `bootstrapEpochRef`.
- New effect subscribes `SessionContext` to `ConnectivityManager`. Every
  real `offline → online` transition re-runs the bootstrap. The terminal
  state is no longer terminal for transient failures.
- Post-onboarding retry now parks on offline instead of burning its single
  retry slot on a doomed attempt.
- `SessionFailureCard` is now state-aware. Waiting / retrying use
  non-alarming copy and iconography; the destructive card is reserved for
  genuinely terminal failures.
- Terminal card renders `NormalizedError.title` / `.message` from the
  catalog — no raw `error.message` leakage.
- Lifecycle map published at `docs/architecture/CONNECTIVITY_LIFECYCLE.md`.

## Gaps deliberately deferred

These were scoped out for this pass and tracked as follow-ups:

1. Phase B migration of remaining raw supabase call sites to `safeQuery` /
   `safeRpc` (representative examples: `useInstalledApps`,
   `useWorkspaceContextReady`, `useSalesDocumentRecord`). Session bootstrap
   is resilient; downstream hooks still surface un-normalized errors on
   mid-app blips. The ESLint rule `local/no-raw-error-message-in-toast`
   escalates when the sweep completes (see `docs/architecture/RESILIENCE.md`).
2. Playwright end-to-end regression for drop-network → auto-recover. Unit
   coverage for the state machine is added; browser-driven coverage is a
   next PR.
3. Realtime + install-state hydration parity check (`useInstalledApps`
   cache envelope + `safeQuery` adoption) — the cache contract in
   `docs/architecture/PWA_HYDRATION.md` is intact; only the underlying
   fetch remains to be migrated.

## Regression validation

- `src/test/resilience/session-recovery.test.ts` covers the state machine
  transitions, parking on offline, resume on reconnect, one-shot auth
  refresh, and fail-fast on deterministic kinds.
- Existing `connectivity-manager.test.ts` and `error-normalizer.test.ts`
  continue to pass — the state machine and vocabulary they enforce are
  the same ones the session bootstrap now consumes.

## Non-negotiables preserved

- No `window.location.reload()` anywhere in the recovery path.
- No arbitrary `setTimeout` outside the computed backoff.
- No try/catch swallowing — all failures flow through `normalizeError`.
- No per-hook redirects to `/login`; `AuthExpiryCoordinator` remains the
  single owner of the auth-expired transition.
