# ADR 0082 — POS Transaction Engine Ownership

Date: 2026-07-18
Status: Accepted
Supersedes: parts of the client-authored money-math and dual-reservation
model documented in `docs/audit/pos-transaction-engine.md`.
Feeds: execution batches T1–T7 (Phase 3).

## Context

The audit (`docs/audit/pos-transaction-engine.md`) established that the
POS transaction engine, while functionally complete for the happy path,
is not yet trustworthy as the canonical retail transaction orchestrator
for a multi-store, multi-terminal, multi-country ERP. Six ranked risks
were identified. This ADR records the ownership decisions that resolve
them and the shape of the batches that will land them.

## Decisions

### D1. Server is the sole source of truth for money math

The client sends *intent*, the server *authorises* and *records*.

- Client payload becomes `{ product_id, qty, requested_unit_price?,
  discount_intent?, note? }` plus header metadata (register, shift,
  customer, payments intent).
- `process_pos_transaction` re-derives unit price (from `price_lists`,
  `product_pricing`, `pos_happy_hours`, promotion rules), tax (from
  `tax_rates` / `tax_groups`), and every arithmetic total.
- Client-supplied totals are advisory only; the RPC returns
  `total_matches_server: boolean` for UX reconciliation. Never persisted
  as authoritative.
- Deviation from server-derived price/discount requires a
  `manager_override_id` row in `pos_manager_overrides` authorising the
  specific line. No override → RPC rejects with SQLSTATE 42501.

### D2. One reservation system

`pos_stock_reservations` is deprecated. The canonical reservation table
is the generic `stock_reservations` with a new `source` enum value
`'pos'` and a `pos_register_id` / `pos_session_id` scope.

- `process_pos_transaction` reads and consumes via the shared
  `reserve_stock` / `release_stock` primitives.
- A compatibility view named `pos_stock_reservations` is retained for
  one migration window, then dropped in a follow-up.

### D3. Idempotency is mandatory

- `process_pos_transaction` signature changes to
  `p_idempotency_key text NOT NULL`; missing key → RPC rejects.
- Unique constraint on `(org_id, business_id, register_id,
  idempotency_key)` is made explicit (materialised as a unique index).
- Client-side `|| crypto.randomUUID()` fallbacks are removed from
  `usePOSTransactionOffline.ts` and `TransactionQueue.ts`. `useCommitKey`
  is the sole producer, backed by both `sessionStorage` and IndexedDB
  so private-browsing degradation cannot silently disable the guard.
- `TransactionQueue.syncAll` gains a startup recovery pass: rows stuck
  in `status='syncing'` older than N seconds → `pending`.

### D4. GL posts per sale, in the commit transaction

- New `post_pos_sale_gl(_txn_id)` composes revenue, COGS, tax and
  tender lines for a single sale.
- Called from within `process_pos_transaction` in the same transaction
  → sales and their GL entries live and die together.
- `trg_pos_shift_close_journal` is demoted to a variance-only
  reconciliation (cash over/short, expected vs actual float). It **no
  longer re-raises** on GL configuration errors — a misconfigured
  account mapping can never trap a cashier mid-shift.
- Rationale: eliminates the "finance-config outage blocks operational
  handoff" coupling; shortens ledger visibility from hours to seconds;
  aligns with Square / Dynamics 365 Commerce patterns rather than the
  Odoo session-batch pattern that inspired the current design.
- Migration: a backfill utility posts per-sale journals for any open
  shifts at cutover; already-closed shifts retain their aggregated
  `post_pos_shift_gl` journal.

### D5. Return / void / recall are compositions, not reimplementations

Three `SECURITY DEFINER` internal helpers become the canonical write
primitives:

- `_pos_insert_line(...)` — pos_transaction_items row.
- `_pos_post_movement(...)` — stock_movements or lot consumption.
- `_pos_record_payment(...)` — pos_transaction_payments row.

`process_pos_return`, `process_pos_void`, `recall_pos_held_transaction`
are rewritten to compose these helpers. No direct `INSERT INTO
stock_movements` / `INSERT INTO pos_transaction_items` outside the
helpers — enforced by an architecture test.

### D6. Availability check is pessimistic

`process_pos_transaction` replaces the aggregate `SELECT` with
`SELECT … FOR UPDATE` over the relevant `stock_quants` rows before the
movement insert. A concurrency test asserts two parallel commits
racing on the last unit cannot both succeed.

### D7. Sale emits three outbox events, atomically

DB triggers emit to `business_event_outbox` inside the commit
transaction:

- `payment.received` (already present).
- `sale.committed` (new).
- `inventory.decremented` (new, per line).

Consumers derive their idempotency key from `pos_transaction_id` — a
runtime assertion + test enforces this in `BusinessSaga` handler
registration.

### D8. Governance duties for privileged POS actions

Duties registered in `governance_duties`:

- `pos.commit`, `pos.void`, `pos.return`.
- `pos.override_price`, `pos.override_discount`, `pos.override_tax`.
- `pos.reprint_receipt`, `pos.recall_held`.

`assert_pos_caller_branch_access` remains the branch-scope guard;
duties layer role/permission on top. Both are checked at the top of
every RPC (Stage R12 contract).

## Consequences

- Client cart code becomes strictly presentation: it may compute
  *display* totals for UX responsiveness, but the persisted numbers
  come from the RPC's return payload. `usePOSCart.ts` is retargeted
  accordingly.
- POS becomes robust to a hostile / stale / bugged client. A crafted
  RPC call cannot inject arbitrary totals into the ledger.
- Overselling risk from the reservation duplication disappears.
- The idempotency guarantee becomes total: no path through the code
  produces a random per-attempt key.
- Every sale is fully financially posted the moment it commits.
  Shift close becomes a fast, deterministic reconciliation.
- Return/void/recall bugs must now be fixed once, not three times.
- Downstream systems (loyalty, analytics, reporting) can subscribe to
  `sale.committed` instead of polling tables.

## Migration & sequencing

Batches ship as one migration each, gated on explicit approval:

1. **T1** — Server-authoritative money math + resolver helper.
2. **T2** — Mandatory idempotency + queue recovery + ESLint rule.
3. **T3** — Unified reservations + compat view.
4. **T4** — Pessimistic availability lock + concurrency test.
5. **T5** — Per-sale GL posting + shift-close demotion + backfill.
6. **T6** — Extract `_pos_*` helpers + rewrite return/void/recall.
7. **T7** — `sale.committed` / `inventory.decremented` outbox events,
   governance duties, final architecture guardrails.

Ordering rationale:

- T3 precedes T4 so pessimistic locks target the unified table.
- T5 precedes T6 so extracted helpers already know about per-sale GL.
- T1/T2 are independent of the reservation/GL work and can ship first.

## Non-goals for Phase 3

Promotions engine internals, loyalty accrual/redemption mechanics,
receipt rendering, hardware execution topology, reporting/analytics
denormalisation, fiscalisation beyond what the commit RPC already
stamps. These are audited in later waves.

## Enforcement

Every batch adds or extends an architecture test:

- `src/test/architecture/pos-no-client-money-math.test.ts` (T1)
- `src/test/architecture/pos-idempotency-key-required.test.ts` (T2)
- `src/test/architecture/pos-reservations-single-source.test.ts` (T3)
- `src/test/architecture/pos-availability-locked.test.ts` (T4)
- `src/test/architecture/pos-per-sale-gl.test.ts` (T5)
- `src/test/architecture/pos-rpc-helpers-only.test.ts` (T6)
- `src/test/architecture/pos-outbox-events-complete.test.ts` (T7)

The R12 in-RPC defense-in-depth test
(`supabase/tests/pos_rpc_defense_in_depth_test.sql`) is extended as new
RPCs land, so `assert_pos_caller_branch_access` remains a compile-time
contract for every money-handling RPC.
