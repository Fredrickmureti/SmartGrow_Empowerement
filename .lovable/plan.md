
# Resilience Audit: Workspace Bootstrap & Connectivity Recovery

Per your instructions, Phase 1 is a **codebase-evidenced investigation, not a fix**. I've done enough reading to state the root cause with confidence and scope the audit; nothing gets changed until you approve.

## 1. Root cause (evidence-backed, not assumed)

The error card comes from `src/components/common/SessionFailureCard.tsx`, rendered by `src/components/auth/OnboardingGuard.tsx` when `useWorkspaceRouting()` returns `status: "error"`. That status is set exclusively from `sessionError` in `src/contexts/SessionContext.tsx`.

Reading `SessionContext.fetchSessionData` (lines 449–513):

- Session bootstrap = a single RPC `get_user_session_data`.
- Retry budget = **3 attempts total** over delays `[0, 400ms, 1200ms]` (~1.6s total).
- The RPC is called via **raw** `supabase.rpc(...)` — **not** `safeRpc` / `safeQueryRetry` from `src/services/resilience/supabaseSafe.ts`. So this critical path bypasses the platform's own resilience wrapper, its timeout race, its offline short-circuit, and its `ConnectivityManager.reportFailure/Success` feedback.
- After the 3rd failure it sets `sessionError` and returns. There is **no listener on `connectivityManager`** in `SessionContext` (grep confirms: zero references). So when the browser comes back online, nothing re-runs the bootstrap. Recovery requires the user to click "Try again" or reload — exactly what you're seeing.
- `refreshSession` (line 834) exists but is only ever fired by the SessionFailureCard button or manual org flows.

So the diagnosis is not "one failed request poisons state" in an abstract sense — it's concretely:

> **Bootstrap uses a bespoke 1.6-second retry loop that is not wired to the connectivity state machine, so a network blip that outlasts ~1.6s becomes a terminal error until the user intervenes.**

Additional weaknesses observed while tracing:

- `ConnectivityManager` (`src/services/resilience/ConnectivityManager.ts`) is well-built (browser + Electron + probe, degraded/offline/online, dedup, realtime grace window) but is **only consumed opportunistically**. `SessionContext`, `OnboardingGuard`, and `useWorkspaceRouting` don't read it. It's currently "decorative" for the bootstrap path — exactly the failure mode you asked to check.
- `SessionFailureCard` has no auto-retry timer, no "waiting for connection" state, and doesn't distinguish `offline` from `server_unavailable` from `auth_expired` (all normalized kinds already exist in `ErrorNormalizer`).
- `OnboardingGuard` uses `react-router-dom` navigation, but the rest of the stack is TanStack Router — worth flagging during the audit for consistency, not part of this fix's scope.
- `attemptFetch` throws on any RPC error including `PGRST301` (JWT expired). That currently counts as one of the 3 attempts and yields a generic failure card instead of triggering a session refresh.
- No last-known-good fallback: even if we previously had a valid `sessionData`, a failed *refresh* replaces nothing but still leaves `sessionError` set — the routing selector already handles the "stale sessionData wins" case correctly (`useWorkspaceRouting` line ~76), so refresh failures don't strand users; only the *initial* bootstrap does.

## 2. Full audit still to perform (Phase 1 deliverables)

Before touching code I will produce, as documents under `docs/audit/`:

1. **Lifecycle map**: launch → auth (`AuthContext`) → session RPC → org resolution → business resolution → entitlements → app shell → background queries. Annotated with: which step uses `safeQuery`, which uses raw supabase, which listens to `connectivityManager`, which has retry, which has a fatal branch.
2. **Error-classification matrix**: enumerate every terminal UI (SessionFailureCard, NoWorkspaceEmptyState, route error boundaries, TanStack Query error components) and map which `NormalizedError.kind` values reach them. Today most paths collapse everything to "fatal".
3. **Retry inventory**: grep every `supabase.rpc`, `supabase.from`, `supabase.functions.invoke`, `fetch(` in `src/contexts/`, `src/hooks/`, `src/providers/`, `src/features/`. Tag each as `safe` (uses supabaseSafe), `raw+retry`, `raw+no-retry`. Expected finding: bootstrap + several hot providers are raw + no retry.
4. **Connectivity-consumer inventory**: everywhere `connectivityManager.subscribe/isOnline/probe` is used. Confirm which surfaces actually react to online→offline→online transitions.
5. **Workspace-recovery trace**: prove whether the app can, in principle, recover without a reload after the terminal card renders (spoiler from the code read: no — only the manual button path).
6. **Comparison note** vs. Odoo web client, QuickBooks Online, Xero, Microsoft 365, Slack, Notion, Shopify Admin, Stripe Dashboard on: offline banner vs. fatal screen, auto-reconnect, queued mutations, session-refresh-on-visibility, exponential backoff caps, jittered retry, per-request vs. per-boundary error handling. Cited where public docs/observations exist.

All conclusions will be linked back to file:line evidence.

## 3. Phased remediation (only after you approve Phase 1)

Nothing below is implemented yet — it's the shape of the fix so you can push back on scope.

**Phase A — Bootstrap resilience (fixes the reported symptom):**
- Route `fetchSessionData` through `safeRpc` with a longer, jittered exponential backoff (e.g. 5 attempts, cap ~30s, honoring `connectivityManager` status so we don't burn attempts while `offline`).
- Subscribe `SessionContext` to `connectivityManager`: on `offline → online` transition, if `sessionError && !sessionData`, auto-retry the bootstrap.
- Distinguish error kinds before setting `sessionError`: `auth_expired` → force `supabase.auth.refreshSession()` then retry once; `offline`/`timeout`/`server_unavailable` → keep retrying in the background; only truly non-retryable errors set the fatal `sessionError`.
- Preserve last-known-good `sessionData` across refresh failures (already partly true; make it explicit).

**Phase B — `SessionFailureCard` UX:**
- Replace terminal card with a state-aware surface: "Reconnecting… (attempt N)" while offline/degraded, "Server unavailable, retrying" for 5xx, current fatal card only for genuine unrecoverable states (e.g. account disabled). Keep sign-out escape hatch.
- No forced page reloads, no arbitrary delays, no `try/catch` swallowing — all decisions come from `NormalizedError.kind` + `ConnectivityManager` state.

**Phase C — System-wide consistency:**
- Migrate remaining raw supabase calls in bootstrap-critical providers (`AuthContext`, `usePlatformAdmin`, business/branding loaders, installed-apps hydration) to `safeQuery`/`safeQueryRetry`.
- Adopt a shared `useAutoRetryOnReconnect(queryKey)` helper so feature-level queries (Sales, POS, Payroll, etc.) invalidate on `offline → online` without each module re-implementing it.
- Add an app-wide connectivity banner (non-blocking, top strip) instead of full-screen crashes for transient states, following the Slack/Notion pattern.

**Phase D — Regression proof:**
- Vitest units covering: bootstrap retries while `connectivityManager` reports `offline`, auto-recovery on transition to `online`, `auth_expired` triggers refresh-then-retry, last-known-good preservation.
- A Playwright script that boots the app, toggles `context.setOffline(true)` mid-bootstrap for 10s, then `false`, and asserts the app reaches the dashboard without a reload and without the SessionFailureCard becoming terminal.
- Manual walk-through checklist across Auth, Dashboard, Sales, Purchases, Inventory, Finance, POS, Payroll, HR, Notifications, Settings.

## 4. Deliverables ordering

1. Audit documents (Section 2) checked into `docs/audit/`.
2. Phase A + B code changes (the actual user-visible fix).
3. Phase C rollout as follow-up PRs per module to keep diffs reviewable.
4. Phase D tests land with the code that makes them pass.

## 5. What I will NOT do

- No error suppression, no blanket try/catch, no forced `location.reload()`, no arbitrary sleeps, no hiding the failure card behind a spinner.
- No changes to `src/integrations/supabase/types.ts`, no schema changes proposed here (this is a client-side resilience fix).
- No rewrite of `ConnectivityManager` — it's sound; the gap is consumers, not the manager.

Approve this plan and I'll start by producing the audit documents in Section 2, then implement Phase A + B against the evidence they surface.
