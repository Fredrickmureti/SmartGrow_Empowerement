# POS Transaction Engine — Enterprise Roadmap

Authoritative status for the POS subsystem. Verify against the live database
via `pg_proc.prosrc` and the migration tree; do not trust prose alone.

---

## Current phase

**Phase 5 (in progress) — RPC parity & sub-flow completeness.**

- ✅ **T8** — `process_pos_void` brought to sale/return parity: advisory
  lock on `(product, warehouse)`, lot-aware reversal via
  `_pos_apply_lot_consumption(direction='in')`, GL reversal via
  `_pos_reverse_transaction_gl`. Legacy overload dropped.
- ✅ **T9 (this batch) — Idempotency response cache.**
  - New table `public.pos_transaction_idempotency` `(idempotency_key TEXT
    PRIMARY KEY, organization_id, business_id, branch_id, register_id,
    rpc_name, transaction_id, response JSONB, created_at, expires_at)`
    with RLS (`SELECT` scoped to caller's branch via
    `user_can_access_branch(auth.uid(), branch_id)`), GRANTs to
    `authenticated` (SELECT) and `service_role` (ALL), and a 24 h
    `expires_at` default.
  - `process_pos_transaction`:
    - reads the cache at entry, **before** any advisory lock — returns
      the exact original body on retry, with `idempotent_replay=true`
      overlaid via `jsonb_set`;
    - retains the legacy `pos_transactions.idempotency_key` lookup as a
      fallback so pre-T9 committed txns still replay (as truncated
      summary);
    - captures the final response in a `v_response` variable, writes it
      to the cache with `ON CONFLICT (idempotency_key) DO NOTHING`, then
      returns `v_response` — cache write commits atomically with the
      sale.
  - `public.cleanup_pos_transaction_idempotency()` reaps expired rows;
    schedule hourly via `pg_cron` (deferred to ops).
- ✅ **Arch guards extended** — `pos-idempotency-response-cache.test.ts`
  (5 checks: table shape + RLS + grants; read-before-lock ordering;
  write-before-return; TTL fn present; no client-side writes to the
  cache table).

**Scope note for T9.** `p_idempotency_key` only exists on
`process_pos_transaction`. `process_pos_return` and `process_pos_void`
are manager-initiated and reference an existing txn (already protected
by `trg_pos_block_void_return_overlap`), so the response-cache pattern
does not apply to them. If a future offline-return client emerges,
symmetric keys will be added at that time.

---

## Cumulative status — verified

### Phase 1 (verification of prior claims)
- ✅ **T1** server-authoritative money math (`pos_resolve_line` + totals in `process_pos_transaction`).
- ✅ **T2** `trg_pos_transactions_require_idempotency_key`.
- ✅ **T3** unified reservations — POS holds live only on `stock_reservations`; legacy `pos_stock_reservations` compat view is dropped (Phase 4).
- ✅ **T4** `pg_advisory_xact_lock` in the sale path.
- ✅ **T5** per-sale GL (`post_pos_sale_gl` via `trg_pos_transaction_post_sale_gl`) + cash-variance trigger.
- ✅ **T7** outbox topics `pos.sale.committed`, `inventory.movement.recorded`, `payment.received`; five POS `governance_duties`.

### Phase 3 batch
- ✅ **T6** helpers `_pos_insert_line`, `_pos_record_payment`, `_pos_apply_lot_consumption`, `_pos_write_stock_movement`.
- ✅ **T6b** return-path advisory lock.
- ✅ **T7 payment.received** topic + trigger `trg_pos_payment_emit_event`.

### Phase 4 drops
- ✅ `pos_stock_reservations` compat view + INSTEAD OF DELETE trigger removed.
- ✅ `post_pos_shift_gl`, `replay_pos_shift_gl`, `generate_pos_shift_journal_entry`, `trg_pos_shift_close_journal_fn` removed.
- ✅ `ShiftReportDialog` "Retry GL" button removed.
- ✅ `businessScopedTables.ts` cleanup.

### Phase 5
- ✅ **T8** — see cumulative + Current phase.
- ✅ **T9** — see Current phase.

### Architecture guards — 18 passing across 5 files
- `pos-server-authoritative-money-math.test.ts`
- `pos-mandatory-idempotency.test.ts` (4)
- `pos-reservations-single-source.test.ts` (4)
- `pos-outbox-and-governance.test.ts`
- `no-client-pos-money-math.test.ts`
- `pos-rpc-helpers-only.test.ts` (4)
- `pos-pessimistic-availability.test.ts` (3)
- `pos-branch-stamping.test.ts` (3)
- `pos-idempotency-response-cache.test.ts` (5)  ← **new in T9**

---

## Pending — next enterprise milestones

### T10 — Outbox delivery worker & DLQ (next up)
`business_event_outbox` currently accumulates rows with no worker. Ship a
Deno edge function `outbox-dispatcher` that:
- Reads `status='pending'` rows in order per `topic` (respect `producer_domain`).
- Dispatches to registered consumers (start with logging sink; real HTTP
  webhooks are Phase 6).
- Retries with exponential backoff up to N attempts, then moves to a new
  `business_event_outbox_dead` table for ops review.
- Cron via `pg_cron` or Supabase scheduled function every 10 s.
- Arch test: DLQ table exists; dispatcher edge function present; a
  scheduled invoker referenced in `supabase/config.toml` or migration.

### T11 — Reporting projection (denormalized read model)
Per-sale JEs make finance-facing analytics slow. Materialize a
`pos_sales_daily` projection populated by trigger on `pos_transactions`
status transitions.

### T12 — Return authorization workflow
`process_pos_return` currently trusts caller-supplied line refunds. Add
`pos_return_authorizations` referencing the original transaction with a
manager override and reason code — required before the return RPC can
proceed for values above threshold. Mirrors D365 "Return with RMA".

### T8-followup — GL reversal helper coverage
Add an arch test asserting `_pos_reverse_transaction_gl` is the sole
reverser and no code path inlines negated JE lines (parity with the
"helpers only" guard for stock).

---

## Handoff instructions for the next agent

**BEFORE writing any new code:**

1. Re-verify T8 + T9 on the live DB:

   ```sql
   SELECT proname,
          (prosrc ~* 'pg_advisory_xact_lock') AS lock_ok,
          (prosrc ~* '_pos_apply_lot_consumption') AS helper_ok,
          (prosrc ~* 'INSERT INTO\s+(public\.)?stock_movements') AS inline_bad
   FROM pg_proc
   WHERE proname IN ('process_pos_transaction','process_pos_return','process_pos_void')
     AND pronamespace='public'::regnamespace;

   SELECT proname,
     (prosrc ~* 'pos_transaction_idempotency[^;]*expires_at\s*>\s*now\(\)') AS reads_cache,
     (prosrc ~* 'INSERT INTO\s+public\.pos_transaction_idempotency') AS writes_cache
   FROM pg_proc WHERE proname='process_pos_transaction' AND pronamespace='public'::regnamespace;
   ```
   All T8 rows must be `lock_ok=t, helper_ok=t, inline_bad=f`; T9 row must
   be `reads_cache=t, writes_cache=t`.

2. Run the full POS arch-guard suite:

   ```
   bunx vitest run src/test/architecture/pos-*.test.ts
   ```
   All 18 checks must pass.

3. Confirm no duplicate function overloads:

   ```sql
   SELECT proname, count(*) FROM pg_proc
   WHERE proname LIKE 'process_pos_%' AND pronamespace='public'::regnamespace
   GROUP BY proname HAVING count(*) > 1;
   ```
   Must return zero rows.

**Then proceed to T10 (outbox dispatcher + DLQ).** Do not skip to T11/T12
— downstream consumers assume in-order, retriable delivery.

**Non-goals for the next batch:** promotions, loyalty, receipt rendering,
hardware integrations, eTIMS, tax-authority hooks. Those are Wave B.
