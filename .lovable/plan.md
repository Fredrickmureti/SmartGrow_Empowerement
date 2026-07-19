# POS Payment Engine — Wave 3 Phase 4

## Phase 1 · Verification of prior work (read-only)

Confirmed against the live codebase before planning Phase 4:

- Phase 0 docs present: `docs/architecture/POS_PAYMENT_ENGINE.md`, `docs/audit/pos-payment-engine.md`.
- Phase 1 schema + 5 SECURITY DEFINER RPCs shipped (`pos_payment_sessions`, `pos_payment_session_tenders`, `pos_payment_session_apply_log`).
- Phase 2 wrapper `src/lib/pos/paymentSessionClient.ts` is the only caller of the 5 session RPCs (architecture guard `pos-payment-session-lifecycle.test.ts` locks this).
- Phase 3 retail online commit — `src/hooks/pos/usePOSTransactionOffline.ts` runs `openSession → recordTender × N → commitSession`; direct `process_pos_transaction` call removed from that hook.
- Two legacy commit paths remain, matching plan.md's "out of scope for Phase 3":
  - `src/pages/pos/POSTerminal.tsx:918` — restaurant flow calls `finalize_table_order` directly.
  - `src/services/offline/TransactionQueue.ts:185` — offline replay calls `process_pos_transaction` directly.
- `PaymentDialog.tsx` still holds all payment-in-progress state in local `useState` (11 hooks).

Prior claims hold. No corrective work needed before Phase 4.

## Phase 4 — Scope

Bring every remaining commit path and the cashier's in-flight payment state onto the server-owned session aggregate. After Phase 4, `pos_payment_session_commit` is the single write path into `pos_transaction_payments` and `PaymentDialog` survives refresh/network loss.

### 4.a — Restaurant commit onto session lifecycle

- Extend `pos_payment_session_commit` (or add a sibling `pos_payment_session_commit_table_order`) to accept an optional `p_table_session_id` / `p_order_id` and forward to `finalize_table_order` when present, `process_pos_transaction` otherwise. Same apply-log guard, same envelope shape, same outbox emission.
- Migrate `POSTerminal.tsx` restaurant branch to call `commitSession` via `paymentSessionClient`. Card FSM metadata continues via `driver_payload` promotion (already shipped in Phase 3.b).
- Update `pos-card-fsm.test.ts` expectation from `finalize_table_order` string match to the wrapper call.
- Delete the direct `supabase.rpc("finalize_table_order")` invocation from the client; keep the DB function itself (server-only forwardee).

### 4.b — Offline replay onto session lifecycle

- `TransactionQueue.processQueuedTransaction` currently posts the whole cart to `process_pos_transaction` with the queued id as idempotency key. Rewrite it to:
  1. `openSession` with the queued id as idempotency key (offline row already carries totals + currency + register).
  2. `recordTender` per queued tender, key `${queuedId}:tender:${i}`.
  3. `commitSession` — returns the same envelope shape the queue already logs.
- Because RPCs are idempotent by `p_idempotency_key`, replays after partial success collapse server-side without producing dupes.
- Extend `pos-offline-replay-uses-rpc.test.ts` to require the wrapper (not the raw RPC) and add a queue-replay integration test that asserts two runs of the same queued row produce a single `pos_transactions` insert + a single set of tenders.

### 4.c — PaymentDialog state migration

- Replace the 11 `useState` hooks with a `usePaymentSession(registerId, cartTotals)` hook that:
  - Opens a session lazily on first tender entry (idempotency key derived from cart hash + register + shift).
  - Records each tender through `recordTender` as the cashier confirms it — server is the source of truth for allocated/remaining.
  - Exposes `{ session, tenders, allocated, remaining, change, status, recordTender, reverseTender, commit, cancel }`.
  - Rehydrates on mount from `pos_payment_sessions` where `status='open'` for the current register — survives refresh, tab close, network partition.
- Client-side change/overtender math deleted; the RPC already returns authoritative values. Enforce with a new arch guard `no-client-payment-math.test.ts` scoped to `src/components/pos/PaymentDialog*`.
- Keep the visual layout untouched in this phase — Phase 5 owns the UX pass. This is a pure state relocation.

### 4.d — Multi-currency + tip snapshot on sessions

- Add columns to `pos_payment_sessions`: `fx_rate numeric`, `settlement_currency text`, `tip_policy text`. Populate from `pos_settings` at `open` time (immutable for the life of the session — prevents mid-payment drift if an admin changes FX).
- Tender rows already carry `amount` in transaction currency; commit-time posting uses the session's frozen fx_rate.

### 4.e — Cancel + abandonment sweeper

- Server-side scheduled job (pg_cron under `/api/public/*` or a Supabase scheduled function — reuse whichever the project already uses for POS housekeeping): every N minutes, mark `open` sessions older than `pos_settings.session_abandon_minutes` (default 30) as `abandoned`, reversing captured card tenders through `pos_payment_session_cancel`.
- Emits `pos.payment.session.cancelled` with reason `abandoned` so downstream (audit, analytics, drawer if cash was captured) can react.

### 4.f — Guards & tests

- Architecture test additions:
  - No `supabase.rpc("finalize_table_order")` or `supabase.rpc("process_pos_transaction")` anywhere under `src/` — allowlist only `paymentSessionClient.ts` and `TransactionQueue.ts` (until 4.b lands, then only `paymentSessionClient.ts`).
  - `PaymentDialog.tsx` may not import from `@/services/pos/paymentMethodResolver` for change/overtender math — those are server responsibilities now.
- SQL contract test: `pos_payment_session_commit` accepts the new table-order forward param and preserves apply-log idempotency for both paths.
- End-to-end Vitest RPC test: open → 2 tenders → commit twice (second is a no-op returning the cached envelope) for both retail and restaurant modes.

### 4.g — Definition of done

- Grep proves zero direct `process_pos_transaction` / `finalize_table_order` client calls remain.
- `PaymentDialog` survives a hard refresh mid-payment: reopening the register restores tenders, remaining, and status from the server.
- `bunx vitest run src/test/architecture` and `src/test/pos` green.
- All five session outbox topics fire on both retail and restaurant commits.
- Legacy `useState`-based payment math deleted, not just bypassed.

## Explicitly out of scope for Phase 4

- Cashier UX overhaul (numpad, quick-tender chips, split-flow redesign) → Phase 5.
- Tender-driver interface unification for card providers → separate wave already scoped.
- Reversal-authorization FSM cross-service unification → Phase 3-style follow-up, tracked separately.

## Technical notes

- Reuse the `${commitKey}:tender:${i}` idempotency derivation already proven in Phase 3 — no new key scheme.
- Apply-log stays `session_id PK`; the table-order forward reuses it, so a retried restaurant commit is as safe as retail.
- Session rehydration query is scoped by `register_id + status='open'` — RLS already restricts by branch, so no new policy needed.
- The abandonment sweeper must run through `pos_payment_session_cancel` (not direct UPDATE) so captured card tenders are actually voided, not just orphaned.
