
## Verification of the previous agent's claims

I inspected the two files it says it changed and cross-referenced them with the resilience layer.

**What actually shipped and works**

- `src/contexts/SessionContext.tsx` (1124 lines) — the bootstrap RPC now runs through `safeRpc` with a 20s timeout, retries 6× with jittered backoff `[0, 500, 1500, 4000, 8000, 15000] ms`, parks in `waiting_for_network` when `connectivityManager.getStatus() === "offline"`, does a one-shot `auth.refreshSession()` on `auth_expired` without consuming an attempt, fails fast on `permission_denied` / `validation`, guards overlapping loops with `inflightBootstrapRef` + `bootstrapEpochRef`, and exposes a `sessionRecovery: { status, attempt, lastErrorKind }` state. A dedicated effect subscribes to `connectivityManager` and, on every real `offline → online` transition, re-runs `fetchSessionData(true)` — this is the missing wire that made the previous state terminal. A visibility-change effect also retries on tab refocus when there's a live `sessionError`.
- `src/components/common/SessionFailureCard.tsx` (165 lines) — subscribes to the manager, distinguishes offline/waiting vs retrying vs terminal, shows non-alarming copy for transient states, and only shows the destructive "We couldn't load your workspace" card when the failure is genuinely non-recoverable.
- `ConnectivityManager.subscribe()` does fire-once with the current state; the `firstFire` gate in `SessionContext` correctly ignores that seed so we don't loop on mount.

**Verdict:** the reported symptom (brief network drop during load → fatal workspace card) is genuinely fixed for the session-bootstrap path. This is not just cosmetic — the state machine actually drives recovery.

## Gaps the previous agent deferred (or didn't notice)

The previous message itself admits three deliverables are outstanding. My audit adds a few more:

1. **Lifecycle map doc is missing.** The prompt explicitly asked for a written map of auth → session → workspace → org → business → permissions → config → connectivity → recovery. Nothing was written to `docs/architecture/`.
2. **Phase C not started.** Many raw `supabase.from(...).select(...)` / `supabase.rpc(...)` call sites still bypass `safeQuery` / `safeRpc`, so they don't feed `ConnectivityManager` and their errors reach the UI un-normalized. Representative examples from a quick scan: `useInstalledApps`, `useWorkspaceContextReady`, org/business resolution, and the generic `useSalesDocumentRecord` peek hook (surfaces raw `error.message`). Until these adopt the resilience layer, other pages can still crash into fatal states on a network blip even though the session bootstrap now recovers.
3. **No global `ConnectivityBanner`.** `docs/architecture/RESILIENCE.md` requires a single global affordance (offline / degraded / realtime-degraded). `ConnectivityProvider` exists but I can't find the banner mounted in `__root.tsx`. Users get no "you're offline" strip; only the session card communicates offline state, and only during initial load.
4. **`SessionFailureCard` still renders `error?.message` verbatim** in the terminal branch (line 158). That leaks raw server text and violates the `no-raw-error-message-in-toast` intent (and its user-facing spirit). Should render the normalized `title`/`message` from `NormalizedError`, not the raw one — the `Error` we throw carries `kind`, but the normalized message is lost.
5. **Post-onboarding retry path** still calls `attemptFetch` once with no connectivity check. If the user goes offline in the 600 ms window, the retry runs and burns without parking. Small, but the pattern should mirror the main loop.
6. **No regression tests.** The prompt asked for a regression validation. `src/test/resilience/*` covers `ConnectivityManager` and `ErrorNormalizer` but not the SessionContext recovery loop or the SessionFailureCard state machine. A Playwright drop-network scenario is also missing.
7. **Realtime + workspace hydration parity.** `useInstalledApps` cache invariants documented in `docs/architecture/PWA_HYDRATION.md` assume a resilient fetch. Right now on cold offline start with a stale cache, the workspace can render "activate" instead of the loader if the fetch throws un-normalized. Needs `safeQuery` adoption inside `useInstalledApps`.

## Plan

### Phase A — Close the documentation and UI gaps (small, high-signal)

1. Write `docs/architecture/CONNECTIVITY_LIFECYCLE.md`: end-to-end map from app boot → auth → session RPC → org/business resolution → install-state hydration → UI, annotated with the failure classes (`offline / timeout / auth_expired / permission_denied / server_unavailable / unknown`) and which layer owns recovery at each step. This is the audit deliverable the prompt asked for.
2. Mount `<ConnectivityBanner />` once in `src/routes/__root.tsx` (or the closest global layout for this project's TanStack Start tree) inside `<ConnectivityProvider>`. Three modes as per `RESILIENCE.md`: offline (red, "You're offline since HH:MM"), degraded (amber), realtime-degraded (subtle "Live updates paused"). Suppress per-feature reconnect toasts elsewhere.
3. Fix `SessionFailureCard` terminal branch to render `NormalizedError.title` + a curated `message` (never raw). Attach the `kind` on the thrown `Error` (already done) and look it up in the card.

### Phase B — Extend recovery beyond session bootstrap

4. Migrate the hottest post-auth fetchers to `safeQuery` / `safeQueryRetry` so a mid-app blip behaves like the session bootstrap:
   - `useInstalledApps` (respects the cache-TTL contract in `PWA_HYDRATION.md`).
   - Workspace context readiness (`useWorkspaceContextReady`) and any org/business resolver hooks it depends on.
   - `useSalesDocumentRecord` peek hook — replace raw `error.message` with a normalized error and let callers render the resilient state.
   These are the paths most likely to reproduce the "fatal on blip" symptom on non-initial navigation.
5. Wire `connectivityManager` into the post-onboarding retry inside `SessionContext.fetchSessionData` so it parks on offline instead of burning the single retry slot.

### Phase C — Regression coverage

6. Add `src/test/resilience/session-recovery.test.ts`: mocks `supabase.rpc` and `connectivityManager`, asserts the state machine transitions `retrying → waiting_for_network → retrying → idle` across an offline→online cycle, that `auth_expired` triggers exactly one `refreshSession` and does not consume an attempt, and that `permission_denied` fails fast.
7. Add `src/test/resilience/session-failure-card.test.tsx`: renders the card with the three `sessionRecovery` states and asserts copy + iconography + button disabled state.
8. Add a Playwright scenario under `/tmp/browser/session-recovery/` that (a) navigates to a protected page, (b) toggles `context.setOffline(true)` mid-load, (c) confirms the "Waiting for connection" card renders, (d) toggles offline back off, (e) confirms the workspace mounts without a reload. Capture screenshots for the deliverable.

### Phase D — Deliverables report

9. Publish a short `docs/audit/2026-07-connectivity-hardening.md` summarizing: root cause (session bootstrap loop was bounded and had no reconnect subscription; other paths still bypass resilience), evidence lines, the lifecycle map, gaps closed vs deferred, and the enterprise SaaS pattern comparison the prompt requested (Odoo/QuickBooks/Xero/Notion approach: unbounded retry + state-machine + banner + preserved user context — matches what we now implement for session, still expanding for the rest).

## Technical details

- Do **not** rewrite `SessionContext` — the previous implementation is architecturally sound. Only touch it for the post-onboarding retry parking and (optionally) to also invalidate `queryClient` after a recovery to refresh downstream caches without a reload.
- Retry policy stays the closed set `{offline, timeout, server_unavailable}` from `supabaseSafe.RETRYABLE_KINDS`. Never extend this to auth/permission/validation.
- Banner must not layer on top of the session card — when both would render, the session card wins (it's the more specific state). Enforce with a single provider owning the render.
- No forced reloads anywhere. No `window.location.reload()`. No `setTimeout(..., N)` outside the backoff computation.
- Query keys touched by `useInstalledApps` continue to obey the `installed-apps-cache-v2-<orgId>` envelope from `PWA_HYDRATION.md` — `safeQuery` wraps the network call, it does not change the cache contract.
