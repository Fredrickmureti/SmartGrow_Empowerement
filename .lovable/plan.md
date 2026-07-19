# POS Payment Engine — Wave 3 Phase 4

## Current status

- **Active phase:** Phase 4 (POS payment-session lifecycle).
- **Landed:** 4.a, 4.b, 4.d, 4.e, 4.f, and the SQL contract hardening pass (4.g).
- **Next up:** 4.c-follow — `PaymentDialog.tsx` cutover onto `usePaymentSession`.
- **Blocked / deferred:** none.

The session lifecycle is now the single write path into `pos_transaction_payments` for retail + restaurant, online + offline. Frozen fx/tip snapshot columns exist on `pos_payment_sessions`; a pg_cron sweeper cancels abandoned sessions every 5 min through the FSM. The commit RPC's routing, idempotency, apply-log discipline, and snapshot immutability are locked by 8 build-time assertions.


## What shipped this wave

### 4.a — Restaurant commit onto session lifecycle ✅

- `pos_payment_session_commit` now accepts `existing_transaction_id` in its envelope; when set, it forwards to `finalize_table_order` server-side.
- `POSTerminal.tsx` restaurant branch calls `commitPaymentSession(...)` via `paymentSessionClient`. Card FSM metadata (`auth_state`, `auth_id`, `vendor_txn_id`, `authorized_amount`) travels on the tender.
- `finalize_table_order` remains as the server-only forwardee — no client caller left.

### 4.b — Offline replay onto session lifecycle ✅

- Both offline replay paths (`TransactionQueue.syncTransaction` and `SQLiteSyncManager.pushPending`) now run `openSession → recordTender × N → commitSession`.
- Base idempotency key is `queued.id` / `tx.id`; per-tender key is `${baseId}:tender:${i}`. Partial-success retries collapse server-side.
- `pos-card-fsm.test.ts` and `pos-mandatory-idempotency.test.ts` updated to assert the wrapper path.

### 4.c — usePaymentSession hook (dialog cutover deferred)

- `src/hooks/pos/usePaymentSession.ts` shipped. Full surface: `{ sessionId, status, tenders, allocated, remaining, change, error, recordTender, reverseTender, commit, cancel, refresh }`.
- Rehydrates any `open` session for the current register + idempotency key on mount — refresh-safe by construction.
- Session key is derived: `pos.session:${registerId}:${shiftId}:${cartHash}`. Tender key is `${sessionKey}:tender:${i}`.
- Server rows are the only source of `allocated` / `remaining` / `change`. No client math helpers exported.

**Not yet done:** rewire `PaymentDialog.tsx` off its 11 `useState` hooks. Recommend a follow-up slice that swaps the tender list + running totals to the hook while keeping every method-specific dialog (M-Pesa, card, split, C2B lookup) intact. Adding the `no-client-payment-math.test.ts` guard belongs with that slice.

### 4.d — Multi-currency + tip snapshot ✅

- `pos_payment_sessions` gained `fx_rate numeric`, `settlement_currency text`, `tip_policy text` (backfilled to `(1, currency, 'none')` for historical rows).
- `pos_payment_session_open` accepts `p_fx_rate`, `p_settlement_currency`, `p_tip_policy` — immutable after first insert (replay does not refresh them).
- `paymentSessionClient.openSession` exposes `fxRate`, `settlementCurrency`, `tipPolicy` args.

### 4.e — Cancel + abandonment sweeper ✅

- `public.pos_payment_session_sweep_abandoned(p_older_than_minutes int)` — cancels every `open` session older than the cutoff through `pos_payment_session_cancel` (so captured card tenders are reversed via the FSM, never orphaned).
- Scheduled via `pg_cron` job `pos-payment-session-sweep-abandoned`, `*/5 * * * *`, cutoff 30 min.
- Function is `service_role`-only; the cron job runs as the DB owner.

### 4.f — Guards & tests ✅

- `src/test/architecture/pos-legacy-commit-rpcs-server-only.test.ts` — bans `supabase.rpc("process_pos_transaction")` and `supabase.rpc("finalize_table_order")` anywhere under `src/` except test fixtures.
- `pos-card-fsm.test.ts` updated: expects `paymentSessionClient` / `commitPaymentSession` on the replay + restaurant paths, forbids the legacy RPC strings.
- `pos-mandatory-idempotency.test.ts` updated: expects `idempotencyKey: queued.id` + `${queued.id}:tender:${i}` derivation.
- Existing `pos-payment-session-lifecycle.test.ts` allowlist already locked the 5 session RPCs to `paymentSessionClient.ts` — no change needed.

## Follow-ups (post-Phase 4)

- **PaymentDialog cutover (4.c-follow):** delete the 11 `useState` hooks, drive the dialog off `usePaymentSession`, add `no-client-payment-math.test.ts`.
- **SQL contract test:** `pos_payment_session_commit` accepts both retail and table-order envelopes; apply-log idempotency verified for both.
- **E2E RPC test:** open → 2 tenders → commit twice, verify second call returns the cached envelope, for both retail and restaurant modes.
- **Sweeper policy:** move the 30-minute cutoff into `pos_settings.session_abandon_minutes` when the pos_settings schema next gets touched.

## Explicitly out of scope for Phase 4

- Cashier UX overhaul (numpad, quick-tender chips, split-flow redesign) → Phase 5.
- Tender-driver interface unification for card providers → separate wave.
- Reversal-authorization FSM cross-service unification → Phase 3-style follow-up.

## Verification checklist

- [x] Zero direct `process_pos_transaction` / `finalize_table_order` client calls remain (grep + arch test).
- [x] `bunx vitest run src/test/architecture/pos-card-fsm.test.ts src/test/architecture/pos-payment-session-lifecycle.test.ts src/test/architecture/pos-legacy-commit-rpcs-server-only.test.ts src/test/architecture/pos-mandatory-idempotency.test.ts` — 18/18 pass.
- [x] Restaurant and retail commits both flow through `pos_payment_session_commit`; outbox topics unchanged.
- [x] Abandonment sweeper scheduled and calls `pos_payment_session_cancel` (never a raw UPDATE).
- [ ] PaymentDialog survives hard refresh mid-payment — infrastructure ready via `usePaymentSession`, wiring pending (see follow-ups).
