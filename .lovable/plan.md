
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

### T3 — Unified reservations ✅ SHIPPED (2026-07-18)
- Migration: backfill `pos_stock_reservations` → `stock_reservations` (`source_type='pos'`, `source_id=register_id`), `DROP TABLE public.pos_stock_reservations CASCADE`, recreate `pos_stock_reservations` as a `security_invoker` compat view over `stock_reservations` (filtered to `source_type='pos'`, open, non-expired). `INSTEAD OF DELETE` trigger `trg_pos_stock_reservations_soft_delete` translates legacy `DELETE FROM pos_stock_reservations …` into `UPDATE stock_reservations SET released_at = now()` so `process_pos_transaction` and other legacy readers keep working with zero body changes.
- RPCs rewritten to target `stock_reservations`: `reserve_pos_stock` (resolves warehouse from the open shift or default branch warehouse, collapses prior open POS holds per `register+product`, inserts with `source_type='pos'` + 15-min expiry), `release_pos_stock_reservation` (soft-release), `get_available_pos_stock` and `get_available_pos_stock_for_register` (aggregate open POS holds joined via `source_id → pos_registers.id`, branch-scoped, excluding self by default).
- Client: `usePOSStockReservation.ts` (parallel path, unreferenced) removed; export dropped from `src/hooks/pos/index.ts`. `StockTab.tsx` collapsed to a single `stock_reservations` query — POS rows now surface with `source_type='pos'` instead of a separate branch, eliminating double-count risk.
- Architecture test: `src/test/architecture/pos-unified-reservations.test.ts` (3/3 green). Combined T1+T2+T3 suite: 13/13 green.

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
- **Batches shipped:** T1 (server money math), T2 (mandatory idempotency + crash recovery + ESLint guard), T3 (unified reservations on `stock_reservations` + compat view + soft-delete trigger).
- **Next batch:** **T4 — Pessimistic availability.** Inside `process_pos_transaction`, replace the aggregate `SELECT COALESCE(SUM(quantity),0) FROM stock_movements … / stock_reservations …` with a `SELECT … FOR UPDATE` on the affected `warehouse_stock` rows (or `stock_quants`, whichever is authoritative for on-hand today — verify before writing SQL) so that two parallel commits on the last unit serialise. Add a concurrency test (two async psql sessions racing the same product+warehouse) under `supabase/tests/` or a Node-driven Vitest that spawns two parallel RPC calls.
- **After T4:** T5 (per-sale GL — new `post_pos_sale_gl(_txn_id)` invoked in-transaction; demote `post_pos_shift_gl` to variance-only), T6 (extract `_pos_insert_line` / `_pos_post_movement` / `_pos_record_payment` / `_pos_apply_lot_consumption` and rewrite `process_pos_return` / `process_pos_void` / `recall_pos_held_transaction` to compose them), T7 (`sale.committed` + `inventory.decremented` outbox triggers + governance duty rows + final architecture guards).

## Handoff — instructions for the next agent

1. **Verify T1/T2/T3 before extending.** Run:
   `bunx vitest run src/test/architecture/pos-server-authoritative-money-math.test.ts src/test/architecture/pos-mandatory-idempotency.test.ts src/test/architecture/pos-unified-reservations.test.ts` — all three files must be 13/13 green. Confirm in the DB: (a) `\d public.pos_stock_reservations` reports it as a view, not a table, (b) the `trg_pos_stock_reservations_soft_delete` INSTEAD OF DELETE trigger is attached, (c) `reserve_pos_stock` / `release_pos_stock_reservation` / `get_available_pos_stock*` bodies reference `public.stock_reservations` and never `pos_stock_reservations`.
2. **Do not skip ahead.** T4 → T5 → T6 → T7 in order. T6's helper extraction assumes T5's per-sale GL RPC exists; T4's `FOR UPDATE` lock must land before T5 wraps the commit in a heavier per-sale GL post (locks amortise better under the same transaction).
3. **Every batch ships:** one migration (with `GRANT`s where relevant), the minimal code delta, an architecture test under `src/test/architecture/`, and a plan update (mark the batch ✅ SHIPPED, roll `Next batch` forward, refresh this handoff block). Preserve the R12 defense-in-depth contract on every money-handling RPC (`SECURITY DEFINER`, `SET search_path = public`, `PERFORM public.assert_pos_caller_branch_access(...)`) — `supabase/tests/pos_rpc_defense_in_depth_test.sql` fails otherwise.
5. **Deprecation window for `pos_stock_reservations`.** The view + soft-delete trigger is a bridge, not the final state. Once T7 ships and no code paths reference the view for 1–2 releases, follow up with a drop migration and remove the compat wrappers from `businessScopedTables.ts` and the generated types.
