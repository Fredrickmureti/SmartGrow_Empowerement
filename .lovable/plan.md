# Banking load: stop the instant "Failed to load" bombardment

## What is actually happening

Confirmed by reading the code (not guessing):

- `useBankAccounts.fetchAccounts` fires **three** network calls per mount (`bank_accounts` select, `bank_account_positions` RPC, `bank_feed_status` RPC) with **no timeout, no retry, no connectivity awareness**.
- `useBankMoney` (`src/hooks/useBankAccountCurrency.ts`) itself calls `useBankAccounts`. So `/bank-feeds` and `/bank-reconciliation` mount `useBankAccounts` **twice** — 6 requests — plus `useBankTransactions`' paginated RPC, all in the same tick on landing.
- Every failure path is a dead end: `console.error("Error resolving bank positions", …)` and `toast.error("Failed to load transactions")` fire on the **first** transport hiccup. `TypeError: Failed to fetch` is a transport-level error (dropped/aborted connection, cold token refresh, slow link) — not "the internet is gone" — yet it is reported as a flat failure with no retry and no way back.
- The project already has the answer and these hooks simply never adopted it: `src/services/resilience/` (`safeQuery` / `safeRpc` / `safeQueryRetry`, `ErrorNormalizer`, `ConnectivityManager`) plus the documented contract in `docs/architecture/RESILIENCE.md`, which says exactly this: wrap user-facing Supabase calls, never render raw errors, retry only transient kinds.

So the diagnosis matches your read: the client treats a slow/flaky-but-present connection as an instant hard failure, and it does so several times over because the same hook is mounted twice.

## The fix

1. **Adopt the resilience seam in the banking hooks**
   - `useBankAccounts`: route the select and both RPCs through `safeQueryRetry` (retries only `offline` / `timeout` / `server_unavailable`, exponential backoff, 15s timeout). Keep already-loaded rows on failure instead of blanking them.
   - `useBankTransactions`: same treatment for `get_bank_transactions_paginated`.
   - Errors become `NormalizedError`, so the copy is honest per kind: transient → "Still loading transactions — the connection is slow. Retrying…"; genuinely offline → "You're offline. Showing the last data we loaded."; permission → the permission message; unknown → a plain failure with a Retry action. No more single generic "Failed to load transactions".

2. **Stop the double mount / request burst**
   - Share one bank-accounts fetch per screen: give `useBankAccounts` a module-level in-flight + short-lived result cache keyed by `org:business:branch`, so the second consumer (`useBankMoney`) joins the same promise instead of issuing a parallel copy. Halves the landing burst on Feeds and Reconciliation.
   - Gate the fetch behind scope readiness (org + business resolved) so nothing fires against a half-hydrated context.

3. **Replace toast-bombing with in-surface state**
   - Banking, Bank Feeds and Reconciliation render a skeleton while first load is in flight, and on failure an inline retry panel ("Couldn't load transactions — Retry"), rather than a toast the moment you land. Toasts stay for user-initiated actions (sync, reconcile), not for page load.
   - While `connectivityManager` reports `degraded`, the existing global `ConnectivityBanner` is the single affordance — banking surfaces do not add their own.

4. **Guard against regression**
   - Extend the banking architecture test to assert that `useBankAccounts` / `useBankTransactions` call Supabase through the resilience helpers, not bare `supabase.from(...)` / `supabase.rpc(...)`.

## Technical notes

- Files touched: `src/hooks/useBankAccounts.ts`, `src/hooks/useBankTransactions.ts`, `src/hooks/useBankAccountCurrency.ts`, `src/pages/Banking.tsx`, `src/pages/BankFeeds.tsx`, `src/pages/BankReconciliation.tsx`, plus a test under `src/test/architecture/`.
- No schema, RLS or RPC changes — this is entirely a client fetch-orchestration and error-presentation fix.
- Retry policy: 2 retries, base delay 400ms, only for transient kinds; deterministic failures (auth/permission/not_found) surface immediately.
