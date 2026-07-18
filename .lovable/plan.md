
# Wave 2 — Checkout & Transaction Engine · Continuation Plan

## Verification of prior work (Phase 1)

Spot-checked the previous engineer's log against the codebase and DB. All claims through Phase C-2 verified:

- **Phase A** — `docs/architecture/POS_CHECKOUT_ENGINE.md` present.
- **Phase B** — `pos_payment_methods` has `tender_kind`/`capture_mode`/`requires_terminal`/`provider_key`; `pos_validate_payment_line` present; arch guards green.
- **Phase D** — `supabase/functions/outbox-dispatcher/index.ts` present, `business_event_outbox_dead` exists, `handler_scope` column on topics, `pg_cron` job `outbox-dispatcher-10s` active. Browser saga passes `p_handler_scope: 'host'`.
- **Phase E (first cut)** — `apply_loyalty_accrual_for_sale` RPC + dispatcher handlers for `pos.sale.committed` and `inventory.movement.recorded` present. `earnPoints(` no longer called in `POSTerminal.tsx` (grep returned no hits).
- **Phase C-1** — `pos_card_fsm_transitions`, guard trigger, and 4 RPCs (`pos_card_authorize/capture/void/reverse`) shipped; arch guard file exists.
- **Phase C-2** — `CardPaymentModal.tsx`, `CardTerminalController.preAuthorize`, retail-path FSM fields forwarded through `usePOSTransactionOffline` (`auth_state`, `vendor_txn_id`, etc. all present).

**No regressions found.** No rework of shipped phases needed. Continuation starts at Phase C-3.

## Roadmap position

Shipped: A · B · D · E-1 · C-1 · C-2
Remaining: **C-3 · E-2 · F · G**

## Phase C-3 — Card FSM completeness

Close the retail-only limitation and make the FSM the sole write path for card `auth_state`.

**C-3.1 Restaurant path parity.** Extend `finalize_table_order(uuid, jsonb, numeric, uuid)` to accept card FSM fields per payment line (`auth_state`, `auth_id`, `vendor_txn_id`, `authorized_amount`, `card_last_four`, `card_type`). Forward to `_pos_record_payment` so the FSM guard applies identically to restaurant sales. New migration; keep 4-arg signature (extend jsonb schema, not arg count). Wire `POSTerminal.tsx` restaurant branch to pass the same payment shape as the retail branch.

**C-3.2 Offline replay through the RPC.** Migrate `SQLiteSyncManager` (lines ~320 / ~379) from direct `.from('pos_transaction_payments').insert(...)` to `process_pos_transaction`. This ensures offline-authorized card sales replay through `_pos_record_payment` and hit the FSM guard. Preserve the queued FSM fields captured in `usePOSTransactionOffline`'s offline payload.

**C-3.3 Post-commit lifecycle UI.** New `CardPaymentActions.tsx` in the transaction-detail surface (`src/components/pos/transaction-detail/` or existing detail screen). Renders Capture / Void / Reverse buttons keyed on current `auth_state`, calling `cardTerminal.capture/void/reverse` (RPC-backed). Uses `capture_mode` to auto-hide Capture when `auth_capture`. Manager PIN gate for Void/Reverse via the existing override matrix.

**C-3.4 Card business events.** Extend the DB-level trigger that already writes `pos_transaction_payments` rows to emit `business_event_outbox` rows on `auth_state` transitions:
- `payment.card.authorized` (idle→approved)
- `payment.card.captured` (approved→captured)
- `payment.card.voided` (approved→voided)
- `payment.card.reversed` (captured→refunded)

All server-scope (settlement/reconciliation consume them). Register no-op handlers in the dispatcher for now; Phase F fills them.

**C-3.5 Arch guards.** Extend `pos-card-fsm.test.ts`:
- `SQLiteSyncManager` does not write directly to `pos_transaction_payments` (grep negative).
- Restaurant path in `POSTerminal.tsx` forwards `auth_state` (grep positive).
- Migration adds card event outbox trigger (regex).
- `CardPaymentActions.tsx` exists and calls only `cardTerminal.*` (no direct RPC).

## Phase E-2 — Downstream projections

Fill remaining E gaps flagged in the log.

- **E-2.1** New `pos_sales_daily` projection table (org/branch/date/gross/net/tax/tender-breakdown JSONB). Migration + `pos_sales_daily_apply(uuid)` idempotent RPC keyed on `pos_transaction_id`. Dispatcher handler for `pos.sale.committed`. Standard GRANT + RLS block.
- **E-2.2** New `pos_customer_purchase_history` projection (customer_id, transaction_id, occurred_at, total, item_count) — server-side handler on `pos.sale.committed`. Delete any UI-driven writes if present.
- **E-2.3** Bank-reconciliation hint rows for `tender_kind IN ('bank','card','wallet')` — new topic `payment.received.bank_hint` (server-scope), handler inserts into `bank_reconciliation_items` with `matched=false`.
- **E-2.4** Arch guard extending `pos-outbox-handlers.test.ts` for the three new map entries + the new tables/RPC.

## Phase F — Settlement & Reconciliation

Depends on C-3.4 emitting card events.

- **F.1** New `pos_card_settlements` table: batch_id, opened_at, closed_at, provider_key, expected_amount, actual_amount, variance, status (`open`/`closed`/`reconciled`). RLS by org/branch. Standard grants.
- **F.2** `pos_card_settlement_lines`: settlement_id, payment_id, amount, fee, net. Populated by dispatcher handler on `payment.card.captured` and `payment.card.reversed`.
- **F.3** Settlement close RPC `pos_close_card_settlement(uuid)` — freezes the batch, computes variance, emits `settlement.card.closed` (server-scope) → GL posting handler creates the clearing→bank JE.
- **F.4** UI: `src/pages/pos/CardSettlementReport.tsx` — list open batches, show expected vs actual, close button (manager PIN).
- **F.5** Arch guard: card captures never bypass settlement (grep every capture path emits the event; settlement RPCs are the only close mechanism).

## Phase G — Cash lifecycle & returns authorization

- **G.1 Cash lifecycle events.** Emit `pos.drawer.opened`, `pos.drawer.closed`, `pos.cash.drop.recorded`, `pos.cash.variance.detected` from existing trigger surfaces (`pos_drawer_events`, `pos_cash_movements`). Host-scope for `opened/closed` (physical drawer signal), server-scope for the accounting-relevant `drop`/`variance`. Handlers write JEs for cash drop (Cash → Safe/Bank clearing) and variance (Cash short/over expense).
- **G.2 Blind close & manager override integration.** Extend `pos_shift_close` RPC to distinguish blind vs open close; blind close records actual=NULL and requires a manager reconciliation pass before the JE fires.
- **G.3 Return authorization state machine.** New `pos_return_authorizations` table with FSM `requested → approved → applied` (or `rejected`). Trigger emits `pos.return.authorized`/`.applied`. Handler creates the reversing JE + inventory movement. Manager PIN gate at `approved` transition.
- **G.4 Arch guards.** Cash JEs originate only from the outbox handler (grep no direct JE inserts in cash paths). Returns cannot post inventory movement without a matching `applied` authorization row.

## Cross-cutting hygiene (during each phase)

- Every new public-schema table ships with `GRANT` block + RLS in the same migration.
- Every new outbox topic gets a row in `business_event_topics` with correct `handler_scope` and `max_attempts`.
- Every dispatcher handler is idempotent, keyed on `source_doc_id`.
- New arch guard tests are added alongside each phase (no phase closes without a guard locking the invariant).
- No secrets in DB; edge function secrets via `add_secret`.

## Definition of done

- All existing POS arch guards remain green; new guards added per phase are green.
- `pos_transaction_payments.auth_state` is only ever written via `pos_card_*` RPCs (verified by guard + DB trigger on all write paths).
- Restaurant and offline-replay sales are indistinguishable from retail sales at the DB level (same FSM path, same events emitted).
- Every card capture produces exactly one settlement line; every settlement close produces exactly one GL entry.
- Cash drawer opens/closes and returns produce complete audit trails via the outbox; no UI-only side effects remain in the checkout path.

## Execution order

C-3.1 → C-3.2 → C-3.3 → C-3.4 → C-3.5 → E-2.1 → E-2.2 → E-2.3 → E-2.4 → F.1–F.5 → G.1–G.4

Each sub-phase ends with: migration applied, arch guard added, typecheck clean, backlog drain verified where applicable.
