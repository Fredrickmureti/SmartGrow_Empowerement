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

## Phase 4.g — SQL contract hardening ✅ (this slice)

New arch guard `src/test/architecture/pos-payment-session-commit-contract.test.ts` (8 assertions):

- **C1** — `pos_payment_session_commit` routes on `existing_transaction_id`: restaurant → `finalize_table_order`, retail → `process_pos_transaction`. No third branch, no rogue commit-side callers.
- **C2** — apply-log lookup executes BEFORE either underlying commit RPC (strip-comments positional analysis on the latest migration body), and `pos_transaction_idempotency` participates in the cached-return path.
- **C3** — exactly one `INSERT INTO pos_payment_session_apply_log(session_id, transaction_id, ...)` per commit, and it precedes the final `RETURN`.
- **C4a** — `pos_payment_session_open` declares `p_fx_rate`, `p_settlement_currency`, `p_tip_policy` AND includes them in the INSERT tuple.
- **C4b** — no plpgsql function body across any session migration mutates the snapshot columns (backfills in migration DDL are exempt by design; runtime paths are locked).
- **C4c** — `open` short-circuits on `(business_id, idempotency_key)` collision (rehydration path exists).
- **Sweeper** — cancels via `pos_payment_session_cancel(...)` and never bypasses the FSM with a raw `UPDATE ... SET status = 'cancelled'`; function is `service_role`-only.

## Next slice — Phase 4.c-follow (PaymentDialog cutover)

Rewire `src/components/pos/PaymentDialog.tsx` (842 lines, 11 `useState` hooks) to consume `usePaymentSession`. Standalone slice because it changes the dialog's prop contract and touches every checkout call site — needs isolated UI verification.

**Scope for the next agent:**

1. **Prop contract.** Add required `sessionContext: { registerId; shiftId; cartHash; cashierId? }`. Every call site (`POSTerminal.tsx` retail + restaurant, split flow) updated in the same slice — no partial adoption.
2. **State migration.** Replace `payments`, `totalApplied`, `totalTendered`, `totalChange`, `remaining`, `change`, and cash-rounding derivations with the hook's server-authoritative `tenders`, `allocated`, `remaining`, `change`. Keep `selectedMethod`, `amount`, `reference`, `cashTendered`, and the four modal-visibility flags — those are pure UI state.
3. **Recording flow.** `handleAddPayment`, M-Pesa `onConfirm`, and card `onAuthorized` all funnel into `session.recordTender(...)` instead of `setPayments`. Errors surface via `session.error`; no local fallback.
4. **Commit.** `onComplete(payments)` becomes `session.commit(envelope)`; parent receives `CommitSessionResult` (transaction_id, receipt_no, change). Restaurant call site passes `existing_transaction_id`; retail omits. The retail `POSTerminal` branch that currently packages payments for `paymentSessionClient.commitSession` can be simplified — dialog owns the whole session.
5. **New guard test.** `src/test/architecture/no-client-payment-math.test.ts`:
   - No `.reduce(` over `payments` / `tenders` inside `PaymentDialog.tsx`.
   - No `useState<PaymentDialogPayment[]>` remaining.
   - `PaymentDialog.tsx` imports `usePaymentSession`.
6. **UI verification (mandatory).** Playwright: cash-only sale (retail), split cash + M-Pesa, card auth + capture, table-order finalisation (restaurant), and mid-payment hard refresh that must rehydrate the same tender list. Screenshot each step.

**Files to touch:** `src/components/pos/PaymentDialog.tsx`, `src/pages/pos/POSTerminal.tsx` (2 call sites), any other component rendering `<PaymentDialog />` (grep first), `src/test/architecture/no-client-payment-math.test.ts` (new).

**Do NOT touch in this slice:** session RPCs (locked by 4.g), `usePaymentSession.ts` (surface sufficient — verify first), `paymentSessionClient.ts`, Card FSM (Phase 3 territory).

## Follow-ups after 4.c-follow

- **Sweeper policy:** move the 30-minute cutoff into `pos_settings.session_abandon_minutes` when the pos_settings schema is next opened. Not blocking.
- **Cashier UX overhaul** (numpad, quick-tender chips, split-flow redesign) → Phase 5.
- **Tender-driver interface unification** for card providers → separate wave.

## Explicitly out of scope for Phase 4

- Any cashier-facing visual redesign.
- Tender-driver interface unification.
- Reversal-authorization FSM cross-service unification.

## Verification checklist

- [x] Zero direct `process_pos_transaction` / `finalize_table_order` client calls remain.
- [x] All 26 Phase-4 arch assertions green: `bunx vitest run src/test/architecture/pos-card-fsm.test.ts src/test/architecture/pos-payment-session-lifecycle.test.ts src/test/architecture/pos-legacy-commit-rpcs-server-only.test.ts src/test/architecture/pos-mandatory-idempotency.test.ts src/test/architecture/pos-payment-session-commit-contract.test.ts`.
- [x] Restaurant and retail commits both flow through `pos_payment_session_commit`; outbox topics unchanged.
- [x] Abandonment sweeper scheduled and calls `pos_payment_session_cancel` (never a raw UPDATE).
- [x] Snapshot columns (`fx_rate`, `settlement_currency`, `tip_policy`) are runtime-immutable — locked by C4b.
- [x] Commit RPC is replay-safe — apply-log lookup precedes underlying RPC — locked by C2.
- [ ] `PaymentDialog` survives hard refresh mid-payment — infrastructure ready, wiring pending in 4.c-follow.
- [ ] `no-client-payment-math.test.ts` guard shipped alongside the cutover.

## Instructions for the next agent

1. **Verify this slice first** before writing any new code:
   - Run the arch suite above. All 26 must pass.
   - Read `src/test/architecture/pos-payment-session-commit-contract.test.ts` end-to-end and confirm each of C1–C4c maps to a real production invariant (not a coincidental grep). If any assertion is a tautology or loophole, fix it before proceeding.
   - Skim the migration bodies for `pos_payment_session_commit`, `pos_payment_session_open`, `pos_payment_session_sweep_abandoned` — confirm the guards reflect the current source.
   - Confirm `usePaymentSession.ts` compiles cleanly under `tsgo` and its rehydration query filters on `register_id + idempotency_key + status IN ('open','recording')`.
2. **Then, and only then, start Phase 4.c-follow** as specified in "Next slice" above. Do not skip the Playwright verification — this is the last piece of the payment engine that is user-visible.
3. **Do not** jump ahead to Phase 5 (cashier UX overhaul) until 4.c-follow lands, its guard test is green, and the refresh-mid-payment Playwright evidence is filed.

