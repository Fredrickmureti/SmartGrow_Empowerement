# POS Transaction Engine — Handoff Verification + T9 Plan

## Phase 1 — Verification of prior claims (done, read-only)

Ran the handoff checks against the live DB and repo:

- ✅ `process_pos_transaction`, `process_pos_return`, `process_pos_void` all show `lock_ok=t`, `helper_ok=t`, `inline_bad=f` in `pg_proc.prosrc`. T8 is genuinely in place.
- ✅ No duplicate `process_pos_%` overloads (each name has exactly 1 row).
- ✅ Triggers present: `trg_pos_transactions_require_idempotency_key`, `trg_pos_transaction_post_sale_gl`, `trg_pos_emit_payment_received` / `trg_pos_payment_emit_event`, `trg_pos_close_variance_gl`, `trg_pos_transaction_emit_event`, branch-stamp + branch/business-match guards across every POS money-handling table.
- ✅ `pos_stock_reservations` compat view is gone; only unified `stock_reservations` remains (Phase 4 drop confirmed).
- ✅ Helper functions `_pos_insert_line`, `_pos_record_payment`, `_pos_apply_lot_consumption`, `_pos_write_stock_movement`, `_pos_reverse_transaction_gl`, `pos_resolve_line`, `post_pos_sale_gl` all exist. `_pos_write_stock_movement` is the sole owner of `INSERT INTO stock_movements` (expected — it's the helper).
- ✅ Arch-test files listed in the plan all exist under `src/test/architecture/` (pos-pessimistic-availability, pos-rpc-helpers-only, pos-reservations-single-source, etc.).
- ✅ Pending-work tables absent as expected: `pos_transaction_idempotency`, `business_event_outbox_dead`, `pos_sales_daily`, `pos_return_authorizations` do not exist.

Conclusion: the previous engineer's Phase 1–4 + T8 claims are accurate. Resume at T9 as documented.

## Phase 2 — Plan validation

The T9→T10→T11→T12 ordering is correct for enterprise retail:
- T9 (idempotency response cache) is the prerequisite for any offline/mobile client — retry-safety today only prevents duplicate INSERTs, it does not return a stable response body.
- T10 (outbox dispatcher + DLQ) unblocks every downstream consumer (finance projections, analytics, fiscal, loyalty).
- T11 (denormalized daily projection) and T12 (return authorization / RMA) sit on top of T9+T10.

One addition worth appending to the roadmap after T9 lands, but **not** part of this batch: an arch test asserting that `_pos_reverse_transaction_gl` is the sole reverser and no code path inlines negated JE lines (parity with the existing "helpers only" guard for stock). Noted for a T8-follow-up ticket; not blocking T9.

No other gaps found that justify reordering. Proceeding with T9.

## Phase 3 — T9: Idempotency response cache

### Goal
`process_pos_transaction` (and, for symmetry, `process_pos_return` / `process_pos_void`) must return the **exact original JSONB response** when called again with the same `p_idempotency_key`, instead of surfacing a unique-violation from the idempotency-key trigger. This is the contract offline POS clients and network-retrying mobile apps rely on.

### Migration 1 — cache table

```sql
CREATE TABLE public.pos_transaction_idempotency (
  idempotency_key   text PRIMARY KEY,
  organization_id   uuid NOT NULL,
  business_id       uuid NOT NULL,
  branch_id         uuid NOT NULL,
  rpc_name          text NOT NULL,        -- 'process_pos_transaction' | 'process_pos_return' | 'process_pos_void'
  transaction_id    uuid,                 -- nullable for void (references existing txn)
  response          jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX idx_pos_txn_idem_expires ON public.pos_transaction_idempotency(expires_at);
CREATE INDEX idx_pos_txn_idem_branch  ON public.pos_transaction_idempotency(branch_id, created_at DESC);

GRANT SELECT ON public.pos_transaction_idempotency TO authenticated;
GRANT ALL    ON public.pos_transaction_idempotency TO service_role;

ALTER TABLE public.pos_transaction_idempotency ENABLE ROW LEVEL SECURITY;

-- Read scoped to caller's branch/business; writes only through SECURITY DEFINER RPCs.
CREATE POLICY pos_txn_idem_read ON public.pos_transaction_idempotency
  FOR SELECT TO authenticated
  USING (public.assert_pos_caller_branch_access(branch_id, business_id, organization_id));
```

### Migration 2 — RPC wiring

For each of the three write RPCs, insert a lookup at the very top of the function body — **before** the advisory lock — and a cache write immediately before returning success:

```
  -- entry: return cached response on retry
  SELECT response INTO v_cached
    FROM public.pos_transaction_idempotency
   WHERE idempotency_key = p_idempotency_key
     AND expires_at > now()
   LIMIT 1;
  IF v_cached IS NOT NULL THEN
    RETURN v_cached;
  END IF;

  -- ... existing body (lock, resolve, insert, GL, emit) ...

  -- exit: cache the response before returning
  INSERT INTO public.pos_transaction_idempotency
    (idempotency_key, organization_id, business_id, branch_id,
     rpc_name, transaction_id, response)
  VALUES (p_idempotency_key, v_org, v_business, v_branch,
          '<rpc>', v_transaction_id, v_response)
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN v_response;
```

Notes:
- `ON CONFLICT DO NOTHING` handles the very narrow race where two concurrent identical calls both pass the entry lookup; one will still complete real work (the `trg_..._require_idempotency_key` trigger on `pos_transactions` will reject the loser, which the wrapper translates to the cached response on the caller's next attempt).
- Cache write happens in the same PL/pgSQL block as the state changes, so it commits atomically — no partial-write window.
- Keep the existing `trg_pos_transactions_require_idempotency_key` in place; it is now the belt-and-braces guard behind the cache.

### Migration 3 — TTL cleanup

```sql
CREATE OR REPLACE FUNCTION public.cleanup_pos_transaction_idempotency()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH d AS (
    DELETE FROM public.pos_transaction_idempotency
     WHERE expires_at < now()
     RETURNING 1
  ) SELECT count(*)::int FROM d;
$$;
```

Scheduled via `pg_cron` hourly (or via the existing Supabase scheduled-function runner if `pg_cron` isn't enabled — check during implementation).

### Arch tests

Add `src/test/architecture/pos-idempotency-response-cache.test.ts` asserting, via `pg_proc.prosrc`:

1. Each of the three RPCs contains a `SELECT ... FROM pos_transaction_idempotency` **before** the first `pg_advisory_xact_lock` call.
2. Each RPC contains an `INSERT INTO pos_transaction_idempotency` before the final `RETURN`.
3. No client-side code writes to `pos_transaction_idempotency` (grep `src/**/*.{ts,tsx}` for the table name outside `src/test/`).

### Verification steps after implementation

```sql
-- 1. Cache table exists with expected columns.
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='pos_transaction_idempotency'
 ORDER BY ordinal_position;

-- 2. All three RPCs read the cache before locking.
SELECT proname,
       (prosrc ~* 'pos_transaction_idempotency[^;]*expires_at\s*>\s*now\(\)') AS reads_cache,
       (prosrc ~* 'INSERT INTO\s+(public\.)?pos_transaction_idempotency')     AS writes_cache
  FROM pg_proc
 WHERE proname IN ('process_pos_transaction','process_pos_return','process_pos_void')
   AND pronamespace='public'::regnamespace;
-- expect reads_cache=t, writes_cache=t for all three
```

Then run the full POS arch-guard suite: `bunx vitest run src/test/architecture/pos-*.test.ts` — the existing 13 must still pass, plus the 3 new assertions in T9's test file.

### Out of scope for this batch
T10 (outbox dispatcher + DLQ), T11 (daily projection), T12 (RMA workflow), promotions, loyalty, receipt rendering, hardware, fiscal — all deferred to the next batches per the roadmap.

### Deliverable
1 migration bundle (3 files: table + RPC rewrites + cleanup fn), 1 new arch test file, `plan.md` updated to mark T9 ✅ and promote T10 to "Current phase".
