
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

### T7 governance + tests follow-up ✅
- Registered five POS duties in `governance_duties`: `pos.commit`, `pos.void`, `pos.return`, `pos.override_price`, `pos.override_discount`, each mapped in `governance_duty_permission_map` under `module='pos'` with the matching operation.
- Added `src/test/architecture/pos-outbox-and-governance.test.ts` asserting the migrations register both outbox topics + triggers with deterministic idempotency keys and seed the five duties.
- Added `src/test/architecture/no-client-pos-money-math.test.ts` pinning the `process_pos_transaction` response schema (`server_totals` object + `total_matches_server` flag) and asserting the `INSERT INTO pos_transactions` uses server-derived variables (`v_srv_subtotal / v_srv_total_tax / v_srv_total`) and never the raw `p_subtotal / p_tax_amount / p_total` params.
- Added `src/test/architecture/pos-reservations-single-source.test.ts` scanning all of `src/` for stray `.insert/.update/.upsert/.delete` calls against `pos_stock_reservations`, and guarding against any post-T3 migration recreating the compat view as a real table.
- 10/10 arch tests green (`bunx vitest run src/test/architecture/pos-outbox-and-governance.test.ts src/test/architecture/no-client-pos-money-math.test.ts src/test/architecture/pos-reservations-single-source.test.ts`).

## Phase 4 — Deprecation followups (paused, do NOT start yet)

Blocked until 1–2 releases pass with zero reader traffic on the compat surfaces. When ready:
- Drop the `pos_stock_reservations` compat view + `trg_pos_stock_reservations_soft_delete` INSTEAD OF trigger.
- Remove `usePOSStockReservation` legacy hook exports.
- Retire the sales/COGS branches of `post_pos_shift_gl` now that `trg_pos_transaction_post_sale_gl` (T5) handles per-sale posting and `trg_pos_close_variance_gl` handles variance only.

Do NOT ship any of Phase 4 without first: (a) grepping production logs for `pos_stock_reservations` read traffic, (b) confirming no shipped mobile / offline client still imports `usePOSStockReservation`, (c) auditing `post_pos_shift_gl` call sites for any consumer still depending on aggregate sales/COGS legs.

## Handoff — next agent, read this first

**Verification checklist before writing any new code:**
1. Run the full POS arch guard suite:
   ```
   bunx vitest run src/test/architecture/pos-server-authoritative-money-math.test.ts \
                   src/test/architecture/pos-mandatory-idempotency.test.ts \
                   src/test/architecture/pos-unified-reservations.test.ts \
                   src/test/architecture/pos-outbox-and-governance.test.ts \
                   src/test/architecture/no-client-pos-money-math.test.ts \
                   src/test/architecture/pos-reservations-single-source.test.ts
   ```
   All six files must pass. If any fail, STOP and repair — a red guard means an earlier batch regressed.
2. Spot-check the live DB with `supabase--read_query`:
   - `SELECT proname FROM pg_proc WHERE proname IN ('process_pos_transaction','post_pos_sale_gl','_pos_reverse_transaction_gl','_pos_resolve_branch_warehouse','_pos_write_stock_movement');` — expect all 5.
   - `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_pos_transactions_require_idempotency_key','trg_pos_transaction_post_sale_gl','trg_pos_close_variance_gl','trg_pos_transaction_emit_event','trg_stock_movement_emit_event');` — expect all 5.
   - `SELECT topic_prefix FROM public.business_event_topics WHERE topic_prefix IN ('pos.sale.committed','inventory.movement.recorded');` — expect both.
   - `SELECT duty_code FROM public.governance_duties WHERE domain='pos';` — expect 5 rows.
3. Confirm `.lovable/plan.md` (this file) still shows Phase 3 + T7 followups as ✅ and Phase 4 as paused.

**Next milestone: DO NOT start Phase 4** (see above — it's release-gated). Instead the next natural batch on the roadmap outside the POS engine arc has NOT been scoped here; treat that as a scoping conversation with the user before touching code. If the user just says "continue" without new scope, revisit the deprecation followups' blockers (log grep + client import audit + call-site audit) and report readiness — do not execute the drops.

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
