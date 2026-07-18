
# POS Transaction Engine — Continuation (Phase 3, Batches T4–T7)

## Phase 1 — Independent verification of prior work

Verified against live DB + tree:

- **T1 Server-authoritative money math** — `pos_resolve_line` present; `process_pos_transaction` re-derives totals; `src/test/architecture/pos-server-authoritative-money-math.test.ts` present. ✅
- **T2 Mandatory idempotency** — trigger `trg_pos_transactions_require_idempotency_key` attached to `public.pos_transactions`; `TransactionQueue.recoverStuckSyncing` and ESLint rule referenced; arch test file present. ✅
- **T3 Unified reservations** — `public.pos_stock_reservations` is a view (`relkind='v'`); `trg_pos_stock_reservations_soft_delete` INSTEAD OF trigger present; `reserve_pos_stock`, `release_pos_stock_reservation`, `get_available_pos_stock`, `get_available_pos_stock_for_register` all exist; arch test file present. ✅
- **T4 Pessimistic availability locking ✅** — `process_pos_transaction` now acquires `pg_advisory_xact_lock(hashtextextended(product_id||':'||warehouse_id, 0))` per tracked line before reading on-hand + reservations. Concurrent commits against the same SKU serialise; loser correctly returns `insufficient_stock` after seeing the winner's `stock_movements` insert.
- **T5 Per-sale GL posting ✅** — see above.
- **T6 Deduplicate return / void / recall ✅** — see above.
- **T7 Event completeness ✅** — Registered two topics in `business_event_topics`: `pos.sale.committed` (producer=sales; consumers=finance/inventory/analytics/crm) and `inventory.movement.recorded` (producer=inventory; consumers=finance/analytics/replication). AFTER-INSERT trigger `trg_pos_transaction_emit_event` emits `pos.sale.committed` per completed sale/return with a deterministic idempotency key (`pos.sale.committed:<txn_id>`). AFTER-INSERT trigger `trg_stock_movement_emit_event` emits `inventory.movement.recorded` for POS-originated `stock_movements` rows (`pos_sale`, `pos_return`) with idempotency key `inventory.movement.recorded:<movement_id>`. Both use `ON CONFLICT (idempotency_key) DO NOTHING` so re-fires from replay/backfill are safe.

**Phase 3 complete.** All of T4–T7 shipped.

## Phase 2 — Batches to ship (in strict order)

### T4 — Pessimistic availability locking

- Identify authoritative on-hand table (verify `warehouse_stock` vs `stock_quants` in DB before writing SQL — plan handoff calls this out).
- In `process_pos_transaction`, replace non-locking aggregate `SELECT` with `SELECT … FOR UPDATE` on the affected on-hand rows (per product + warehouse), executed before any `stock_movements` insert.
- Re-check availability after lock acquisition; on shortage raise `insufficient_stock` with product + on-hand + requested.
- Concurrency test: Vitest that fires two parallel RPC calls for the last unit against a seeded product; expect exactly one success and one `insufficient_stock`. File under `src/test/architecture/pos-pessimistic-availability.test.ts` plus a `supabase/tests/` static assertion that the RPC body contains `FOR UPDATE` against the on-hand table.

### T5 — Per-sale GL posting

- New RPC `post_pos_sale_gl(_txn_id uuid)`: derives revenue / COGS / tax / tender legs from a single `pos_transactions` row (+ items + payments), inserts one `journal_entries` + `journal_entry_lines` set, stamps `journal_entry_id` back on `pos_transactions`.
- Reuse existing account-mapping resolution used by `post_pos_shift_gl` (extract shared helpers rather than fork).
- Invoke `post_pos_sale_gl` in-transaction from `process_pos_transaction` after item/payment inserts. Also invoke from `process_pos_return` (produces reversing entry) and `process_pos_void` when appropriate.
- Demote `trg_pos_shift_close_journal`: shift close no longer posts sales GL; it posts **only cash variance / over-short** entries. Failure of the variance leg must NOT re-raise — log to `pos_shift_close_errors` and continue.
- Migration includes backfill: for currently-open shifts, run `post_pos_sale_gl` for any `pos_transactions` lacking `journal_entry_id`.
- Arch test: `process_pos_transaction` body references `post_pos_sale_gl`; `trg_pos_shift_close_journal_fn` no longer aggregates sales/COGS/tax.

### T6 — Deduplicate return / void / recall

Extract SECURITY DEFINER internal helpers (private schema or `_internal` prefix, revoke from PUBLIC):

- `_pos_insert_line(_txn_id, _line jsonb)` — item insert + tax stamping.
- `_pos_post_movement(_txn_id, _product_id, _qty, _direction)` — `stock_movements` insert respecting lock discipline from T4.
- `_pos_record_payment(_txn_id, _payment jsonb)` — payment row + M-Pesa attach.
- `_pos_apply_lot_consumption(_txn_id, _line, _direction)` — lot / serial consumption via `consume_lots_atomic`.

Rewrite `process_pos_transaction`, `process_pos_return`, `process_pos_void`, `recall_pos_held_transaction` to compose these helpers only. Preserve all R12 guards (`SECURITY DEFINER`, `search_path=public`, `assert_pos_caller_branch_access`).

Arch test `src/test/architecture/pos-rpc-helpers-only.test.ts`: greps RPC bodies to assert no direct `INSERT INTO stock_movements` / `INSERT INTO pos_transaction_items` / `INSERT INTO pos_transaction_payments` outside the helpers.

### T7 — Event completeness + governance + final guards

- DB triggers emit to `business_event_outbox`:
  - `sale.committed` on `pos_transactions` insert (post-commit — combine with existing branch-stamp trigger ordering).
  - `inventory.decremented` on POS-scoped `stock_movements` insert (source_type = `pos_transaction`).
  - Keep existing `payment.received`.
- Idempotency key on outbox payload derived from `pos_transaction_id` (+ event name for uniqueness across event types on the same txn). `BusinessSaga` handler contract asserts presence at runtime; add unit test.
- Register governance duties in `governance_duties`: `pos.commit`, `pos.void`, `pos.return`, `pos.override_price`, `pos.override_discount` — permission group / duty-permission map rows in the same migration.
- Final architecture tests:
  - `no-client-pos-money-math.test.ts` — schema-level: `p_subtotal / p_tax_amount / p_total` treated as advisory; only `server_totals` persisted (`total_matches_server` column present).
  - `pos-reservations-single-source.test.ts` — no `INSERT INTO pos_stock_reservations` / no DDL references outside the compat shim.
  - `pos-outbox-lifecycle.test.ts` — asserts three triggers emit expected events.
- Plan file (`.lovable/plan.md`) updated: T4–T7 marked ✅, handoff block refreshed, `record_bill_payment_atomic → record_multi_bill_payment` doc-typo fixed.

## Per-batch shipping contract (unchanged from prior batches)

Every batch = one migration (GRANTs where relevant, RLS preserved) + minimal code delta + architecture test + plan update. Every money-handling RPC keeps `SECURITY DEFINER`, `SET search_path = public`, `PERFORM public.assert_pos_caller_branch_access(...)` at the top. No edits to `src/integrations/supabase/types.ts`. No `ALTER DATABASE`. Verify `supabase/tests/pos_rpc_defense_in_depth_test.sql` still passes after each batch.

## Deprecation followups (post-T7)

- Drop the `pos_stock_reservations` compat view + soft-delete trigger after 1–2 releases with no readers.
- Remove `usePOSStockReservation` legacy exports fully.
- Retire `post_pos_shift_gl` sales/COGS branches once the variance-only refactor stabilises.

## Out of scope for this arc

Promotions engine, loyalty accrual/redemption, receipt rendering, hardware topology, reporting denormalisation, eTIMS beyond stamping — separate waves.

## Definition of done

- Every sale's totals server-computed (T1 ✅) and pessimistically stock-checked (T4).
- Single reservation system (T3 ✅) and single posting path (T6).
- Idempotency mandatory end-to-end (T2 ✅).
- GL posts per sale in the commit transaction (T5); shift close is variance-only.
- `sale.committed` / `inventory.decremented` / `payment.received` cover the lifecycle with idempotent handlers (T7).
- Architecture tests guard each invariant.
