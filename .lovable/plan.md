# POS Checkout 400 — Root Cause + Fix

## Incident report

**Symptom.** `POST /rest/v1/rpc/pos_payment_session_open` returns HTTP 400. The dialog surfaces the generic toast *"Some of the information you entered is not valid."* No sale can be tendered.

**Root cause — duplicate SQL overload of `pos_payment_session_open`.** Two live definitions coexist in the database:

```
pos_payment_session_open(uuid, numeric, text, text, numeric, uuid)                              -- legacy (Phase 4.a)
pos_payment_session_open(uuid, numeric, text, text, numeric, uuid, numeric, text, text)         -- current (Phase 4.d snapshot fields)
```

Verified via `pg_proc` (both bodies inspected — the 6-arg version predates the FX / `settlement_currency` / `tip_policy` snapshot columns; the 9-arg version is the one every arch test in `pos-payment-session-commit-contract.test.ts` asserts against). `src/integrations/supabase/types.ts:74991-75016` already reflects both overloads as a union.

PostgREST resolves overloads by matching the JSON body key-set to a function's parameter names. When the client (`src/lib/pos/paymentSessionClient.ts:232`) sends the full 9-key payload with any optional (`p_cashier_id`) omitted, both overloads are viable candidates — the 9-arg because every key maps to a parameter; the 6-arg because its required subset `{p_register_id, p_grand_total, p_currency, p_idempotency_key}` is present and the 6-arg simply doesn't recognize the extra keys as an error. PostgREST returns `PGRST203 — Could not choose the best candidate function`, HTTP 400. This is the exact same failure mode ADR 0009 called out for `finalize_table_order` and fixed by dropping the legacy overload; the same discipline was not applied when Phase 4.d shipped the snapshot fields.

**Why the arch tests didn't catch it.** `pos-payment-session-commit-contract.test.ts` matches the *migration text* with a `CREATE OR REPLACE FUNCTION` regex — that guarantees the new definition is created, but a `CREATE OR REPLACE` with a different argument list creates a **new overload**, not a replacement. Nothing in the suite introspects `pg_proc` to verify overload count. Classification: **migration issue** (missing `DROP FUNCTION` for the superseded overload) plus a **guard gap** (no pg_proc-shape assertion).

**Secondary defect — diagnostic loss.** `ErrorNormalizer.ts:88-93` maps every 400 to the `validation` kind with the generic message and discards PostgREST's `code`/`hint`/`details`. `POSPaymentSessionError` already captures those fields; the toast layer throws them away. This is why the real cause was invisible until pg_proc inspection.

## Fix

Scope-locked. No new features, no arch changes, no compatibility shim.

### 1. Migration — drop the legacy overload

Single migration mirroring ADR 0009's `finalize_table_order` cleanup:

```sql
DROP FUNCTION IF EXISTS public.pos_payment_session_open(uuid, numeric, text, text, numeric, uuid);
```

The 9-arg current overload becomes the sole entry point. No client change needed — `paymentSessionClient.openSession` already passes the full 9-arg shape.

### 2. Arch guard — lock overload uniqueness

New test `src/test/architecture/pos-payment-session-single-overload.test.ts`. Uses the SQL introspection idiom already established elsewhere in the suite: reads the latest `pos_payment_session_*` migration texts and asserts

- exactly one `CREATE OR REPLACE FUNCTION public.pos_payment_session_open(` with 9 typed parameters,
- a matching `DROP FUNCTION IF EXISTS public.pos_payment_session_open(uuid, numeric, text, text, numeric, uuid)` exists,
- symmetric checks scaffolded for the other session RPCs (`record_tender`, `reverse_tender`, `commit`, `cancel`) so a future overload-drift regression fails the build.

This closes the guard gap that let Phase 4.d ship with a duplicate.

### 3. Diagnostic surface — no generic mask for structured PostgREST errors

Narrow, minimal edit to `PaymentDialog.tsx` error path (and the `usePaymentSession` toast callback): when a caught error is a `POSPaymentSessionError` **and** it carries a non-null `code`/`hint`/`details`, surface `${message} [${code}]` in the toast body and log the full triple. `ErrorNormalizer` stays untouched — this is a targeted opt-out for the payment-session error class only, so unrelated 400s keep their curated copy. No swallowing, no fallbacks — the failure still throws.

## Verification

1. Re-run the arch suite plus the new guard: `pos-mandatory-idempotency`, `pos-payment-session-lifecycle`, `pos-legacy-commit-rpcs-server-only`, `pos-payment-session-commit-contract`, `pos-card-fsm`, `no-client-payment-math`, `pos-payment-session-single-overload`, `payment-method-resolver`. Expect all green.
2. Introspect `pg_proc` post-migration: exactly one `pos_payment_session_open` row.
3. Manually drive the running preview via Playwright headless — retail cash sale, split (cash + M-Pesa), card auth/capture, restaurant table finalize, mid-payment hard refresh (session rehydrate). Screenshot each terminal state; file under `docs/audit/2026-wave3-checkout-postmortem/`.
4. Offline replay: `TransactionQueue` + `SQLiteSyncManager` flush a queued sale — confirm the same idempotency key collapses cleanly against the newly single overload.

## Explicitly not doing

- No changes to `paymentSessionClient` argument shape.
- No changes to session snapshot columns or FSM.
- No broad `ErrorNormalizer` rewrite.
- No optional-parameter loosening on the RPC.
- No new wave features.

## Deliverables

- Migration dropping the legacy 6-arg overload.
- New arch guard `pos-payment-session-single-overload.test.ts`.
- Targeted diagnostic surface for `POSPaymentSessionError` in the dialog.
- Playwright evidence bundle for the five checkout scenarios.
- Postmortem entry appended to `.lovable/plan.md` under Wave 3 close-out, upgrading Wave 4 follow-up #1 (Playwright evidence) to *done* since we file it here.
