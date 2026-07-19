## What's verified so far (evidence, not assumption)

1. **Live DB — the function is present, single overload, callable**
   `public.pos_payment_session_commit(p_session_id uuid, p_transaction_envelope jsonb)`, `SECURITY DEFINER`, owner `postgres`, `EXECUTE` to `PUBLIC`. No overloads. No ambiguity.
2. **PostgREST reachability (proof it is NOT 404 server-side right now)**
   `POST https://jkszmrroyjfdwokbkzis.supabase.co/rest/v1/rpc/pos_payment_session_commit` from the sandbox with the anon key and the exact payload the client sends returned **HTTP 500** `{"code":"P0002","message":"pos_payment_session_commit: unknown session …"}`. That is the function executing and rejecting a bogus id — PostgREST resolved the RPC, it did not 404.
3. **Client contract matches server**
   `src/lib/pos/paymentSessionClient.ts::commitSession` posts `{ p_session_id, p_transaction_envelope }` via `supabase.rpc(...)`; arg names + types match live signature. All callers (`usePaymentSession`, `usePOSTransactionOffline`, `services/offline/TransactionQueue`, `SQLiteSyncManager`) route through this single wrapper. No duplicate RPC, no legacy name.
4. **No route interceptor**
   No `src/routes/api/**` handler and no `vercel.json` rewrite intercepts `/rest/v1/rpc/*`.
5. **Migration timeline is consistent with what's live**
   `20260718234953` (introduce) → `…000450` (return jsonb) → `…000732` (logic) → `…004259` (retail + `finalize_table_order` dual-mode). All `CREATE OR REPLACE` on the same `(uuid, jsonb)` signature; grants restored in the base migration and now show `PUBLIC EXECUTE`.

**Consequence:** the reported `404` is not reproducible against the current live server. Which means the 404 is coming from a client-side layer between the POS UI and Supabase — not from the RPC being missing / renamed / mis-signed. I refuse to name a root cause without proof, so this plan is an investigation plan that produces the fix, not a speculative fix.

## Diagnosis plan (in order, stop as soon as one is confirmed)

### Step 1 — Capture the actual failing request
Run the checkout flow in the exact environment the incident was seen (preview vs published) and capture the failing request from DevTools → Network:
- Full **Request URL** (host, path, query string)
- **Request headers**: `apikey`, `Authorization`, `Content-Type`, `Prefer`
- **Request body**
- **Response headers**: especially any `cf-*`, `x-served-by`, `sw` markers
- **Response body**

This one artifact discriminates every remaining hypothesis:

| What the captured request shows | Root cause | Fix |
|---|---|---|
| Host ≠ `jkszmrroyjfdwokbkzis.supabase.co` | Old bundle hardcoded a different `SUPABASE_URL` — deployment drift | Republish current frontend (frontend deploys are gated by "Update") |
| Host correct, path has a **trailing slash or extra segment** (e.g. `/rpc/pos_payment_session_commit/`, `/rpc/pos_payment_session_commit_v2`) | Stale JS calling an old / renamed RPC (leftover in the service-worker cache) | Bust the PWA cache (bump SW version), then republish |
| Host + path correct, `Content-Type` missing or body encoded as form data | A rogue wrapper around `supabase.rpc` | Remove the wrapper |
| Host + path correct, response body is HTML (Cloudflare / Vercel 404) | Response is not reaching Supabase at all — an intermediate proxy (SW, browser extension, corporate proxy) is short-circuiting | Fix the intermediary, then republish |
| Host + path + body correct AND response is a genuine PostgREST 404 JSON | PostgREST schema cache stale on that Supabase edge PoP | `NOTIFY pgrst, 'reload schema'` from a migration + verify |

### Step 2 — Rule out the PWA/service-worker cache path
POS ships offline infrastructure (`src/services/offline/*`, `TransactionQueue`, `SQLiteSyncManager`). If a service worker is registered and serving a bundle built before the current commit RPC signature, every checkout will 404 even though the server is healthy. Verify by:
- Checking DevTools → Application → Service Workers for a registered SW and its script URL.
- Comparing the loaded `paymentSessionClient` bundle hash to the one produced by the current build.
- Confirming there is (or is not) an entry in `TransactionQueue` retrying against an outdated RPC name.

If confirmed, the fix is a controlled SW cache invalidation (bump the SW/cache version constant) so old clients pick up the current bundle on next load. **Not** a compat wrapper on the server.

### Step 3 — Verify schema-cache freshness (only if Step 1 shows a genuine PostgREST 404 JSON)
If — and only if — the captured 404 body is a PostgREST JSON error like `PGRST202 "Could not find the function public.pos_payment_session_commit …"`, ship a one-line migration:
```sql
NOTIFY pgrst, 'reload schema';
```
plus a `SELECT pg_notify('pgrst', 'reload schema');` in the same migration to force reload on every PostgREST replica. This is legitimate only in that case; otherwise it is theatre.

### Step 4 — Fix, then verify end-to-end
Once Step 1 pinpoints the layer:
1. Apply the smallest change that removes the underlying defect (see the table above — no compat wrappers, no silenced errors).
2. Re-run the checkout from the same environment; capture the same request/response as in Step 1 and confirm HTTP 200 with a `transaction_id`.
3. Confirm downstream rows: one row in `pos_transactions` (status `completed`), matching rows in `pos_transaction_items` and `pos_transaction_payments`, one row in `pos_payment_sessions` transitioning to `committed`, and the corresponding `pos_payment_session_apply_log` entry (idempotency guard populated).
4. Re-run the same commit with the SAME idempotency key: the RPC must return `idempotent_replay: true` and NOT create duplicate rows.
5. Regression sweep on the surrounding flow: `pos_payment_session_open` → `pos_payment_session_record_tender` × N → `pos_payment_session_commit`; and the dine-in path via `existing_transaction_id` → `finalize_table_order`.

## Deliverables (produced during build mode)

- Captured failing request/response from Step 1 (pasted verbatim).
- Named root cause with the specific evidence line.
- List of files changed and why.
- Verification log for Step 4 (before/after DB row counts, network 200, idempotent replay).
- Why the issue escaped previous verification (e.g. architecture tests scan repo, not the shipped SW cache; migrations verify DB, not the client bundle in the user's browser).

## What this plan explicitly refuses to do

- No new `pos_payment_session_commit` overload, alias, or compat wrapper on the DB unless Step 3 proves a schema-cache issue.
- No `catch { /* ignore */ }` around the commit call.
- No renaming of the RPC or the client function.
- No unrelated refactoring of `paymentSessionClient`, `usePaymentSession`, or `TransactionQueue`.
