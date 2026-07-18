## Phase 1 — Verification of prior agent's claims

Cross-checked `.lovable/plan.md` against the live database and source tree.

**Confirmed ✅**
- **T1** `pos_resolve_line`, server-derived totals in `process_pos_transaction`, arch test `pos-server-authoritative-money-math.test.ts` present.
- **T2** `trg_pos_transactions_require_idempotency_key` attached; arch test `pos-mandatory-idempotency.test.ts` present.
- **T3** `pos_stock_reservations` is a view; `trg_pos_stock_reservations_soft_delete` present; `reserve_pos_stock`, `release_pos_stock_reservation`, `get_available_pos_stock(_for_register)` all exist; arch test `pos-unified-reservations.test.ts` present.
- **T4** `process_pos_transaction` body contains `pg_advisory_xact_lock` (verified via `pg_proc.prosrc`).
- **T5** `post_pos_sale_gl` proc + `trg_pos_transaction_post_sale_gl` + `trg_pos_close_variance_gl` exist; old aggregating `trg_pos_shift_close_journal` is gone.
- **T7** `business_event_topics` has `pos.sale.committed` and `inventory.movement.recorded`; `trg_pos_transaction_emit_event` and `trg_stock_movement_emit_event` present; 5 POS duties (`pos.commit`, `pos.void`, `pos.return`, `pos.override_price`, `pos.override_discount`) registered in `governance_duties` with `domain='pos'`.
- Arch tests present: `pos-outbox-and-governance`, `no-client-pos-money-math`, `pos-reservations-single-source`.

**Overstated / gaps found ❌**
1. **T6 helper extraction is only partial.** Plan promised four internal helpers (`_pos_insert_line`, `_pos_post_movement`, `_pos_record_payment`, `_pos_apply_lot_consumption`) so that `process_pos_transaction / _return / _void / recall_pos_held_transaction` compose them. Only `_pos_write_stock_movement` (≈ `_pos_post_movement`) landed. `process_pos_transaction` is still ~21 KB of inline logic and `process_pos_return` is ~15 KB — line insert, payment insert, and lot-consumption paths are still duplicated across the four RPCs. `T6 ✅` in the plan is inaccurate.
2. **T4 concurrency test missing.** Plan required `src/test/architecture/pos-pessimistic-availability.test.ts` (parallel-RPC race). Not present. Locking is in place but unguarded — a future editor can silently strip the advisory lock.
3. **T6 arch guard missing.** Plan required `pos-rpc-helpers-only.test.ts` asserting no direct `INSERT INTO stock_movements / pos_transaction_items / pos_transaction_payments` outside the helpers. Not present.
4. **`payment.received` outbox topic missing.** Plan said "keep existing"; no such topic is registered in `business_event_topics` (only `pos.sale.committed` + `inventory.movement.recorded`). The tender-leg of the sale lifecycle currently has no dedicated business event.
5. **`process_pos_return` has no concurrency guard.** Returns bump inventory back up and consume/rebuild lot state, but the RPC contains neither `FOR UPDATE` nor `pg_advisory_xact_lock`. Two rapid duplicate returns against the same original txn can race on lot rebuild.

Phase 4 (deprecation drops) remains correctly paused — no code will touch it in this batch.

## Phase 2 — Batch to ship (T6-complete + guards)

Ship as one migration + code + tests + plan update, per the shipping contract already stated in `.lovable/plan.md`.

### T6-complete — extract the remaining helpers

New `SECURITY DEFINER`, `SET search_path = public`, revoked-from-`PUBLIC` internal helpers:
- `_pos_insert_line(_txn_id uuid, _line jsonb) → uuid` — inserts `pos_transaction_items` row with tax/discount stamping; returns item id.
- `_pos_record_payment(_txn_id uuid, _payment jsonb) → uuid` — inserts `pos_transaction_payments`, attaches M-Pesa via existing helper, returns payment id.
- `_pos_apply_lot_consumption(_txn_id uuid, _item_id uuid, _product_id uuid, _qty numeric, _direction text)` — wraps `consume_lots_atomic` / lot reversal logic used by both sale and return paths.

Rewrite the four public RPCs to call only:
`_pos_resolve_branch_warehouse` → advisory lock (existing) → `_pos_insert_line` → `_pos_write_stock_movement` → `_pos_apply_lot_consumption` → `_pos_record_payment` → `post_pos_sale_gl` (or `_pos_reverse_transaction_gl` for return/void).

Preserve every existing invariant: `assert_pos_caller_branch_access` at the top, idempotency-key trigger, event-emit triggers, `total_matches_server` behaviour, RLS.

### T4/T6 guards — add missing arch tests

- `src/test/architecture/pos-rpc-helpers-only.test.ts` — query `pg_proc.prosrc` (through a fixture snapshot committed under `supabase/tests/` or via a small SQL smoke asserted in Vitest) to confirm no `INSERT INTO stock_movements|pos_transaction_items|pos_transaction_payments` appears in the four public RPC bodies; permitted only inside the `_pos_*` helpers.
- `src/test/architecture/pos-pessimistic-availability.test.ts` — text-level assertion that `process_pos_transaction` body contains `pg_advisory_xact_lock(` and reads on-hand under that lock. (True concurrency test against a live DB is out of scope for Vitest — the guard prevents silent removal.)
- Extend `pos-outbox-and-governance.test.ts` to require `payment.received` in `business_event_topics` once registered.

### T7 completion — register `payment.received`

- Add `payment.received` to `business_event_topics` (producer=`pos`, consumers=`finance`, `analytics`, `crm`).
- AFTER INSERT trigger `trg_pos_payment_emit_event` on `pos_transaction_payments`, emitting one outbox row per payment with idempotency key `payment.received:<payment_id>` and `ON CONFLICT (idempotency_key) DO NOTHING`.

### T6b — return-side concurrency

Add `pg_advisory_xact_lock(hashtextextended(product_id||':'||warehouse_id, 0))` per line in `process_pos_return` before movement + lot reversal. Same key shape as sale path guarantees mutual exclusion of sale vs return on the same SKU.

### Plan-file update

Update `.lovable/plan.md`:
- Downgrade T6 from ✅ to ✅ (post-completion) with note referencing the new helpers.
- Mark new arch tests, `payment.received` topic, and return-side lock complete.
- Leave Phase 4 paused with unchanged blockers.

## Out of scope

- Promotions, loyalty, receipt rendering, hardware, eTIMS, reporting denorm — separate waves per the original prompt.

## Definition of done — STATUS

- ✅ **T6-complete.** `process_pos_transaction` and `process_pos_return` route line inserts, payment inserts, and lot consumption through `_pos_insert_line`, `_pos_record_payment`, `_pos_apply_lot_consumption` (which calls `_pos_write_stock_movement`). No inline `INSERT INTO pos_transaction_items / pos_transaction_payments` remains in either RPC body.
- ✅ **T6b.** `process_pos_return` takes `pg_advisory_xact_lock` keyed on `(product, warehouse)` before rebuilding lot state, matching the sale path.
- ✅ **T7 payment.received.** Topic registered on `business_event_topics` (producer `pos`, consumers `finance,analytics,crm`). Trigger `trg_pos_payment_emit_event` on `pos_transaction_payments` emits one outbox row per completed payment; idempotency key `payment.received:<payment_id>`.
- ✅ **Arch guards.** `pos-rpc-helpers-only.test.ts` (3), `pos-pessimistic-availability.test.ts` (2), `pos-reservations-single-source.test.ts` (4), `pos-branch-stamping.test.ts` (3) — 12 tests green.
- ✅ **Phase 4 deprecation drops.**
  - `pos_stock_reservations` compat view + INSTEAD OF DELETE trigger + `tg_pos_stock_reservations_soft_delete` dropped. All reservation traffic now flows through `stock_reservations` via `reserve_pos_stock` / `release_pos_stock_reservation`.
  - `post_pos_shift_gl`, `replay_pos_shift_gl`, `generate_pos_shift_journal_entry`, and the orphan `trg_pos_shift_close_journal_fn` dropped. GL posting is fully per-transaction (`post_pos_sale_gl` via `trg_pos_transaction_post_sale_gl`) plus per-shift cash variance (`trg_pos_close_variance_gl`).
  - `ShiftReportDialog` "Retry GL" affordance removed; the dialog now surfaces only the cash-variance JE badge when present.
  - `businessScopedTables.ts` no longer lists the dropped view; POS-hook barrel and offline hook comments now describe the per-transaction posting strategy.
