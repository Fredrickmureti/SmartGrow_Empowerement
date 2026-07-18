
# Phase 3 — POS Transaction Engine Ownership & Integrity

Diagnostic evidence lives in the audit report just produced. This plan turns that report into an ADR + phased execution, matching the shape of Phase 2 (Warehouse). Refactor-freely posture: existing RPCs/tables may be renamed, replaced, or consolidated.

## Verdict (from audit)

The engine has a single atomic commit RPC, branch-isolation guards, an outbox-based event fanout, and architecture tests preventing client writes to cash/drawer/shift. It is **not yet trustworthy** as the canonical orchestrator because:

1. `process_pos_transaction` trusts client-supplied subtotal / tax / discount / total / unit_price verbatim — no server recomputation. The GL later posts these numbers as ground truth.
2. Two disconnected reservation systems (`pos_stock_reservations` vs generic `stock_reservations` / `reserve_stock`) — overselling exposure.
3. Idempotency has a silent fallback (`|| crypto.randomUUID()` in `usePOSTransactionOffline.ts:245`) that defeats replay-collapse on the online path.
4. `process_pos_return` reimplements item / stock-movement / payment posting instead of reusing helpers shared with `process_pos_transaction`.
5. `post_pos_shift_gl` failure at shift close re-raises and blocks the entire shift close — finance-config health becomes an operational availability risk.
6. Stock availability check inside the commit is a non-locking `SELECT` aggregate → race under concurrent terminals.

## Step 0 — Artefacts

Write two audit docs (source of truth for the ADR and batches):

- `docs/audit/pos-transaction-engine.md` — the full lifecycle trace, ownership map, and ranked risk register from the subagent report, with `file:line` citations.
- `docs/audit/pos-transaction-lifecycle-canonical.md` — the enterprise lifecycle we hold ourselves to (basket → resolve → availability → reserve → authorize → commit → movement → GL → analytics/audit → close) and where each stage lives today.

## Step 1 — ADR 0082: POS Transaction Engine Ownership

`docs/adr/0082-pos-transaction-engine-ownership.md`. Key decisions:

- **Server is the sole source of truth for money math.** Client sends `{ product_id, qty, requested_unit_price?, discount_intent }`; RPC re-derives unit price, tax, line total, subtotal, discount, and total from `products`, `price_lists`, `product_pricing`, `pos_happy_hours`, `tax_rates`, `tax_groups`. Client totals become advisory + a `total_matches_server` bool for UX, never persisted as authoritative.
- **One reservation system.** `pos_stock_reservations` is deprecated in favour of the generic `stock_reservations` with a `source='pos'` scope. `process_pos_transaction` consumes / releases via the shared `reserve_stock` / `release_stock` primitives.
- **Idempotency is mandatory.** `p_idempotency_key text NOT NULL`; the RPC rejects calls without one. Client fallback to `crypto.randomUUID()` is removed; `useCommitKey` is the only source, backed by both `sessionStorage` and IndexedDB.
- **Commit posts the GL immediately per sale** (Square/D365-style) instead of at shift close (Odoo-style). Rationale: eliminates the "finance-config outage blocks cashier handoff" coupling and shortens ledger visibility from hours to seconds. Shift close becomes a variance-reconciliation step, not a batch GL post. Legacy `post_pos_shift_gl` retained as a variance/reconciliation helper only.
- **Return / void / recall are thin wrappers** over shared internal helpers (`_pos_insert_line`, `_pos_post_movement`, `_pos_record_payment`) — no reimplemented posting.
- **Sale emits `sale.committed` and `inventory.decremented` to the outbox** in the same transaction as the commit; `payment.received` already does this. Handlers must be idempotent by `pos_transaction_id`.
- **Availability check is pessimistic** — `SELECT … FOR UPDATE` on the affected `stock_quants` rows within the commit.

## Step 2 — Execution batches

Each batch ships as one migration + minimal code changes + an architecture test. Nothing runs without your explicit approval per batch.

### T1 — Server-authoritative money math ✅ SHIPPED (2026-07-18)
- Migration `20260718175250_...`: `pos_resolve_line(...)` helper + `process_pos_transaction` rewritten to re-derive unit price, tax, discount and totals from the catalog. Client deviations require an approved, unconsumed `pos_manager_overrides` row (marked consumed on use) or the RPC rejects with `price_override_required` / `manager_override_required`.
- Server totals (`v_srv_subtotal`, `v_srv_total_tax`, `v_srv_total`) persisted onto `pos_transactions` — client `p_subtotal`/`p_tax_amount`/`p_total` are advisory only.
- Return payload exposes `server_totals` + `total_matches_server` for UX reconciliation.
- Architecture test: `src/test/architecture/pos-server-authoritative-money-math.test.ts` (6/6 green).

### T2 — Idempotency hardening ✅ SHIPPED (2026-07-18)
- Migration: `tg_pos_transactions_require_idempotency_key` BEFORE INSERT trigger on `pos_transactions` — rejects NULL/blank keys with `not_null_violation`. Historical rows untouched; the partial unique index `(org_id, business_id, register_id, idempotency_key) WHERE idempotency_key IS NOT NULL` continues to collapse replays.
- Client: `usePOSTransactionOffline.ts` no longer falls back to `crypto.randomUUID()` — throws at the boundary if `data.idempotency_key` is missing. `useCommitKey` remains the sole client source.
- `TransactionQueue.recoverStuckSyncing()`: rows in `syncing` older than 30s revert to `pending` at boot / before each `syncAll()`. `queued.id` is still the idempotency key, so replays are safe.
- ESLint rule `local/no-pos-commit-without-idempotency-key` — registered and set to `error`.
- Architecture test: `src/test/architecture/pos-mandatory-idempotency.test.ts` (4/4 green).

### T3 — Unified reservations ⏳ NEXT
- Migration: introduce `stock_reservations.source` enum incl. `pos`; backfill from `pos_stock_reservations`; deprecate the POS-specific table (view for compat during migration window).
- `process_pos_transaction` reads/writes via `reserve_stock` / `release_stock`.
- `usePOSStockReservation.ts` retargeted; drop parallel path.

### T4 — Pessimistic availability
- Inside `process_pos_transaction`, replace the aggregate `SELECT` with a `SELECT … FOR UPDATE` over the relevant `stock_quants` rows before the movement insert. Add a concurrency test (two parallel commits, last-unit race).

### T5 — Per-sale GL posting
- New `post_pos_sale_gl(_txn_id)` invoked in-transaction from `process_pos_transaction` (revenue / COGS / tax / tender lines per sale).
- `trg_pos_shift_close_journal` demoted to variance-only (cash over/short); shift close no longer re-raises on GL config errors.
- Backfill script + doc for existing open shifts.

### T6 — Deduplicate return / void / recall
- Extract `_pos_insert_line`, `_pos_post_movement`, `_pos_record_payment`, `_pos_apply_lot_consumption` as `SECURITY DEFINER` internal helpers.
- Rewrite `process_pos_return`, `process_pos_void`, `recall_pos_held_transaction` to compose these helpers.
- Architecture test: grep RPC bodies to assert no direct `INSERT INTO stock_movements` / `INSERT INTO pos_transaction_items` outside the helpers.

### T7 — Event completeness + guardrails
- DB triggers emit `sale.committed` and `inventory.decremented` to `business_event_outbox` alongside existing `payment.received`.
- `BusinessSaga` handler contract requires an `idempotencyKey` derived from `pos_transaction_id`; enforced by a runtime assertion + test.
- Governance duties: `pos.commit`, `pos.void`, `pos.return`, `pos.override_price`, `pos.override_discount` registered in `governance_duties`.
- Final architecture tests:
  - `no-client-pos-money-math` — client cart may compute *display* totals but must not send authoritative values to the RPC (schema level).
  - `pos-reservations-single-source` — no references to `pos_stock_reservations` outside the deprecation shim.
  - `pos-rpc-helpers-only` — return/void/recall bodies match the composed shape.

## Technical notes (for engineers, not the user)

- Every new/modified RPC keeps `SECURITY DEFINER`, `SET search_path = public`, and `PERFORM public.assert_pos_caller_branch_access(...)` at the top (Stage R12 contract, already covered by `pos_rpc_defense_in_depth_test.sql`).
- Public-schema tables added/altered here must ship their `GRANT` block in the same migration and keep RLS on.
- No `ALTER DATABASE postgres` anywhere; no direct edits to `src/integrations/supabase/types.ts`.
- Migration ordering respects existing FKs — reservation unification (T3) precedes T4 (which locks on the unified table). T5 precedes T6 so the extracted helpers already know about per-sale GL.
- Every batch adds or extends an architecture test under `src/test/architecture/` or `supabase/tests/` so drift is caught in CI, not review.

## Out of scope (later waves)

Promotions engine, loyalty accrual/redemption, receipt rendering, hardware execution topology, reporting/analytics denormalisation, fiscalisation (eTIMS) beyond what the commit RPC already stamps. These will be audited separately once T1–T7 land.

## Definition of done

- Every POS sale's totals are computed and validated server-side.
- One reservation system, one movement-posting code path.
- Idempotency key is mandatory and enforced end-to-end.
- GL posts per sale, in-transaction; shift close is variance-only.
- `sale.committed` / `inventory.decremented` / `payment.received` outbox events cover the lifecycle and are consumed idempotently.
- Architecture tests prevent regression on each of the above.

## Status board (2026-07-18)

- **Active phase:** Phase 3 — POS Transaction Engine Ownership & Integrity.
- **Batches shipped:** T1 (server money math), T2 (mandatory idempotency + crash recovery + ESLint guard).
- **Next batch:** **T3 — Unified reservations.** Consolidate `pos_stock_reservations` into the generic `stock_reservations` (`source='pos'`), backfill, expose a deprecation view, retarget `usePOSStockReservation.ts` and the availability lookup in `process_pos_transaction` to `reserve_stock` / `release_stock`.
- **After T3:** T4 (pessimistic `FOR UPDATE` availability), T5 (per-sale GL), T6 (dedup return/void/recall via `_pos_*` helpers), T7 (`sale.committed` + `inventory.decremented` outbox events + governance duties).

## Handoff — instructions for the next agent

1. **Verify T1/T2 before extending.** Run:
   `bunx vitest run src/test/architecture/pos-server-authoritative-money-math.test.ts src/test/architecture/pos-mandatory-idempotency.test.ts` — both must be 10/10 green. Confirm `tg_pos_transactions_require_idempotency_key` is attached to `public.pos_transactions`.
2. **Do not skip ahead.** T3 → T4 → T5 → T6 → T7 in order. T4's `FOR UPDATE` lock assumes T3's unified table; T6's helper extraction assumes T5's per-sale GL RPC exists.
3. **Every batch ships:** one migration (with `GRANT`s where relevant), the minimal code delta, an architecture test under `src/test/architecture/`, and a plan update. Preserve the R12 defense-in-depth contract on every money-handling RPC (`SECURITY DEFINER`, `SET search_path = public`, `PERFORM public.assert_pos_caller_branch_access(...)`) — `supabase/tests/pos_rpc_defense_in_depth_test.sql` fails otherwise.
4. **Do not touch other phases.** Phases 1 (Procurement) and 2 (Warehouse Ownership) are closed. The Inventory Domain audit (batches I1–I7) is paused until Phase 3 POS batches T3–T7 land.
