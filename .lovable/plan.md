# POS Transaction Engine — Enterprise Roadmap

Authoritative status for the POS subsystem. Verify against the live database
via `pg_proc.prosrc` and the migration tree; do not trust prose alone.

---

## Current phase

**Phase 4 — DONE.** All planned deprecation drops shipped; per-transaction GL
is the only path; legacy compat surfaces are gone.

**Phase 5 (in progress) — RPC parity & sub-flow completeness.**
- ✅ **T8 (this batch)** — `process_pos_void` brought to sale/return parity:
  advisory lock on `(product, warehouse)`, lot-aware reversal through
  `_pos_apply_lot_consumption(direction='in')`, GL reversal via
  `_pos_reverse_transaction_gl`. Legacy overload of `process_pos_void`
  dropped so callers can only reach the hardened signature
  `(p_transaction_id, p_organization_id, p_voided_by, p_void_reason_id,
  p_void_note, p_override_id)`.
- ✅ **Arch guards extended.** `pos-pessimistic-availability.test.ts` now
  covers all three write RPCs (transaction/return/void); `pos-rpc-helpers-only.test.ts`
  asserts void reverses stock through the lot helper and never inlines a
  `stock_movements` INSERT.

---

## Cumulative status — verified

### Phase 1 (verification of prior claims)
- ✅ **T1** server-authoritative money math (`pos_resolve_line` + totals in `process_pos_transaction`).
- ✅ **T2** `trg_pos_transactions_require_idempotency_key`.
- ✅ **T3** unified reservations — POS holds live only on `stock_reservations`; legacy `pos_stock_reservations` view is dropped (Phase 4).
- ✅ **T4** `pg_advisory_xact_lock` in the sale path.
- ✅ **T5** per-sale GL (`post_pos_sale_gl` via `trg_pos_transaction_post_sale_gl`) + cash-variance trigger.
- ✅ **T7** outbox topics `pos.sale.committed`, `inventory.movement.recorded`, `payment.received`; five POS `governance_duties`.

### Phase 3 batch
- ✅ **T6** helpers `_pos_insert_line`, `_pos_record_payment`, `_pos_apply_lot_consumption`, `_pos_write_stock_movement`.
- ✅ **T6b** return-path advisory lock.
- ✅ **T7 payment.received** topic + trigger `trg_pos_payment_emit_event`.

### Phase 4 drops
- ✅ `pos_stock_reservations` compat view + `INSTEAD OF DELETE` trigger + `tg_pos_stock_reservations_soft_delete`.
- ✅ `post_pos_shift_gl`, `replay_pos_shift_gl`, `generate_pos_shift_journal_entry`, and `trg_pos_shift_close_journal_fn`.
- ✅ `ShiftReportDialog` "Retry GL" button removed; only cash-variance JE badge remains.
- ✅ `businessScopedTables.ts` cleanup; POS hook comments updated.

### Phase 5 (this batch)
- ✅ **T8** — see "Current phase" above.

### Architecture guards — 13 passing across 4 files
- `pos-server-authoritative-money-math.test.ts`
- `pos-mandatory-idempotency.test.ts`
- `pos-reservations-single-source.test.ts` (4)
- `pos-outbox-and-governance.test.ts`
- `no-client-pos-money-math.test.ts`
- `pos-rpc-helpers-only.test.ts` (4) — includes void-reverses-through-helper
- `pos-pessimistic-availability.test.ts` (3) — sale, return, void
- `pos-branch-stamping.test.ts` (3)

---

## Pending — next enterprise milestones

### T9 — Idempotency response cache (next up)
The idempotency-key trigger prevents duplicate INSERTS but does not return
the original response body on retry. Enterprise POS clients (offline sync,
mobile) need the exact same `jsonb` payload on retry, not a
`duplicate_key`-shaped error. Design:
- New table `pos_transaction_idempotency` `(idempotency_key TEXT PRIMARY KEY,
  organization_id, business_id, branch_id, transaction_id, response JSONB,
  created_at)`.
- `process_pos_transaction` looks up the key at entry; on hit returns the
  cached `response` and skips all writes. On success it caches the return
  value in the same transaction.
- 24 h retention TTL via scheduled cleanup or partitioned drop.
- Arch test: RPC body reads from the cache table before the advisory lock.

### T10 — Outbox delivery worker & DLQ
`business_event_outbox` currently accumulates rows with no worker. Ship a
Deno edge function `outbox-dispatcher` that:
- Reads `status='pending'` rows in order per `topic` (respect `producer_domain`).
- Dispatches to registered consumers (start with logging sink; real HTTP
  webhooks are Phase 6).
- Retries with exponential backoff up to N attempts, then moves to a
  `business_event_outbox_dead` table for ops review.
- Cron via `pg_cron` or Supabase scheduled function every 10s.

### T11 — Reporting projection (denormalized read model)
Per-sale JEs make finance-facing analytics slow. Materialize a
`pos_sales_daily` projection populated by trigger on
`pos_transactions` status transitions.

### T12 — Return authorization workflow
`process_pos_return` currently trusts caller-supplied line refunds. Add
`pos_return_authorizations` referencing the original transaction with a
manager override and reason code — required before the return RPC can
proceed for values above threshold. Mirrors D365 "Return with RMA".

---

## Handoff instructions for the next agent

**BEFORE writing any new code:**

1. Re-verify the T8 state on the live database by running:

   ```sql
   SELECT proname,
          (prosrc ~* 'pg_advisory_xact_lock') AS lock_ok,
          (prosrc ~* '_pos_apply_lot_consumption') AS helper_ok,
          (prosrc ~* 'INSERT INTO\s+(public\.)?stock_movements') AS inline_bad
   FROM pg_proc
   WHERE proname IN ('process_pos_transaction','process_pos_return','process_pos_void')
     AND pronamespace='public'::regnamespace;
   ```
   All three rows must be `lock_ok=t, helper_ok=t, inline_bad=f`. If any row
   fails, T8 regressed — fix before moving to T9.

2. Run the full arch-guard suite:

   ```
   bunx vitest run src/test/architecture/
   ```
   All 13 tests in the POS files must pass.

3. Confirm no duplicate function overloads:

   ```sql
   SELECT proname, count(*) FROM pg_proc
   WHERE proname LIKE 'process_pos_%' AND pronamespace='public'::regnamespace
   GROUP BY proname HAVING count(*) > 1;
   ```
   Must return zero rows.

**Once verified, proceed to T9 (idempotency response cache).** Do not skip
to T11/T12 — the outbox worker (T10) and idempotency cache (T9) together
make the engine safe for offline-first clients, which every downstream
feature will assume. Ship T9 → T10 in that order, each as a single
migration + code + tests + this plan update.

**Non-goals for the next batch:** promotions, loyalty, receipt rendering,
hardware integrations, eTIMS, tax-authority hooks. Those are Wave B.
