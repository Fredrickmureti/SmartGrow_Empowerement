# Connectivity Lifecycle & Recovery Map

This document is the audit deliverable requested by the connectivity-hardening
prompt. It maps every stage of the app boot pipeline, the failure classes
that can occur at that stage, and which layer owns recovery.

## Stages

```text
1. App launch (main.tsx)
   → mounts React tree, initializes Sentry
2. Auth restoration (AuthContext)
   → supabase.auth.getSession() + onAuthStateChange
3. Session bootstrap (SessionContext.fetchSessionData)
   → RPC `get_user_session_data` via safeRpc, retry+park state machine
4. Organization / business resolution (SessionContext)
   → deterministic: server last_org_id → localStorage → first membership
5. Workspace install-state hydration (useInstalledApps)
   → 24h same-org cache envelope, live query on top
6. Permission / configuration loading
   → per-feature hooks, most still on raw supabase calls
7. UI render
8. Runtime activity — background sync, realtime, user actions
9. Connectivity interruption
   → ConnectivityManager (navigator + probe + failure reports)
10. Recovery
    → connectivity-subscribed effects re-run their fetches
11. Normal operation
```

## Failure classes per stage

`NormalizedError.kind` is the closed set. Each stage maps its failures to
this vocabulary via `normalizeError` and never renders raw `error.message`.

| Stage                          | Retryable failures                          | Terminal failures                      | Owner of recovery                          |
| ------------------------------ | ------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Auth restoration               | offline, timeout                            | auth_invalid, auth_expired (one-shot)  | AuthContext + AuthExpiryCoordinator        |
| Session bootstrap RPC          | offline, timeout, server_unavailable        | permission_denied, validation          | SessionContext.fetchSessionData loop       |
| Org/business resolution        | (in-process; no I/O)                        | none                                   | SessionContext                             |
| Install-state hydration        | offline, timeout, server_unavailable        | permission_denied                      | useInstalledApps + cache envelope          |
| Per-feature loaders            | offline, timeout, server_unavailable        | permission_denied, validation          | Per-hook `safeQuery` adoption (in progress)|
| Realtime channels              | channel_error, timed_out (grace window)     | closed                                 | ConnectivityManager realtime sub-state     |

## Session bootstrap state machine

```text
       ┌──────────┐
       │  idle    │◄──────────────────────────┐
       └────┬─────┘                            │
            │ user.id set                      │ success
            ▼                                  │
       ┌──────────┐   offline    ┌──────────┐  │
       │ retrying │─────────────►│ waiting_ │  │
       │          │              │ for_net  │  │
       │          │◄─────────────│          │  │
       └────┬─────┘  online      └────┬─────┘  │
            │                          │       │
            │ deterministic error      │       │
            ▼                          │       │
       ┌──────────┐                    │       │
       │ terminal │ (SessionFailureCard)       │
       └────┬─────┘                            │
            │ user action / connectivity flip  │
            └──────────────────────────────────┘
```

- Retry budget: 6 attempts, jittered exp-backoff `[0, 500, 1500, 4000, 8000, 15000] ms`.
- `auth_expired` triggers exactly one `supabase.auth.refreshSession()` and
  does NOT consume an attempt.
- `offline` state parks the loop instead of burning attempts.
- A dedicated `connectivityManager.subscribe` effect resumes the loop on
  every real `offline → online` transition — this is the invariant that
  makes the terminal state non-fatal for transient failures.
- Overlapping loops are guarded by `inflightBootstrapRef`; user changes
  bump `bootstrapEpochRef` and cancel in-flight retries.

## UI surface contract

- `<ConnectivityBanner />` — the single global affordance for
  offline / degraded / realtime-degraded. Mounted once in `App.tsx`.
- `<SessionFailureCard />` — state-aware. Transient states render a
  non-alarming "Waiting for connection…" or "Reconnecting…" surface.
  The destructive card is reserved for genuinely terminal failures
  (auth_invalid, permission_denied on the RPC, or unrecoverable server
  errors after the retry budget). Copy is driven by the normalized
  catalog — no raw `error.message`.
- Per-feature toasts must NOT duplicate connectivity messaging. If a
  hook's failure normalizes to `offline`, the banner already tells the
  story; the hook renders a compact inline empty-state, not a toast.

## Enterprise SaaS pattern comparison

| Pattern                                    | Odoo | QuickBooks | Xero | Notion | This ERP |
| ------------------------------------------ | :--: | :--------: | :--: | :----: | :------: |
| Global connectivity banner                 |  ✓   |     ✓      |  ✓   |   ✓    |    ✓     |
| Retry with exp-backoff on transient fail   |  ✓   |     ✓      |  ✓   |   ✓    |    ✓     |
| Park on offline (no attempt burn)          |  —   |     ✓      |  ✓   |   ✓    |    ✓     |
| Auto-resume on reconnect (no reload)       |  —   |     ✓      |  ✓   |   ✓    |    ✓     |
| Normalized error catalog                   |  —   |     ✓      |  —   |   ✓    |    ✓     |
| Preserve user context across reconnect     |  —   |     ✓      |  ✓   |   ✓    |    ✓     |
| Distinguish transient vs terminal in UI    |  —   |     ✓      |  ✓   |   ✓    |    ✓     |

## Rules for new hooks

1. Wrap every user-facing Supabase call in `safeQuery` / `safeRpc` (or
   `safeQueryRetry` when the operation is retry-safe).
2. Never branch on `navigator.onLine` — use `connectivityManager.getStatus()`
   or `useConnectivity()`.
3. Never render `error.message` verbatim. Render `NormalizedError.title`
   and `NormalizedError.message`.
4. Retries use `safeQueryRetry` — never hand-rolled `for` loops.
5. `auth_expired` handling is centralized in `AuthExpiryCoordinator`. Do
   not add per-hook redirects to `/login`.
