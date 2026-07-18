# POS Transaction Engine — Audit (Phase 3, Step 0)

Date: 2026-07-18
Status: Diagnostic — sourced from the enterprise POS engine audit performed
at the start of Phase 3. Feeds ADR 0082 and execution batches T1–T7.

Scope: **only** the POS transaction engine (checkout/sale commit lifecycle).
Promotions, loyalty, receipt rendering, hardware execution topology,
reporting and fiscalisation are out of scope and audited separately.

---

## 1. Lifecycle trace (normal sale, end-to-end)

- **UI entry** — `src/pages/pos/POSTerminal.tsx` orchestrates the cart
  (`src/hooks/pos/usePOSCart.ts`), the payment dialog
  (`src/components/pos/PaymentDialog.tsx`), and commit via
  `src/hooks/pos/usePOSTransactionOffline.ts`.
  `src/hooks/pos/usePOSTransaction.ts:1-6` is a deprecated re-export.
- **Commit hook** — `usePOSTransactionOffline.ts:73-112` branches on
  `syncManager.checkOnline()`.
  - Online → `processOnlineTransaction` (`:181-273`) → RPC
    `process_pos_transaction`.
  - Offline → `processOfflineTransaction` (`:275-361`) enqueues into
    `transactionQueue` (IndexedDB, `src/services/offline/TransactionQueue.ts`).
- **Idempotency key** — `src/hooks/pos/useCommitKey.ts:11-17,44-57`
  derives a sessionStorage-scoped key per register+shift, cleared only on
  success, passed as `p_idempotency_key`.
- **`process_pos_transaction`** (latest def:
  `supabase/migrations/20260530140301_...sql`):
  1. Replay lookup by `(org, business, register, idempotency_key)` and
     short-circuits on hit.
  2. Resolves register → branch/business/org.
  3. Calls `assert_pos_caller_branch_access(...)`.
  4. Requires ≥1 payment for positive-total sales.
  5. **Stock availability check** against `stock_movements` aggregate
     minus `pos_stock_reservations` — pre-insert, **non-locking**
     (no `SELECT … FOR UPDATE`) → check-then-act race under concurrent
     terminals.
  6. Payment validation (tendered ≥ applied; non-cash cannot return
     change).
  7. Inserts `pos_transactions` → `pos_transaction_items` (posting
     `stock_movements` or `consume_lots_atomic`) → `pos_transaction_payments`
     → updates `pos_shifts` counters → deletes
     `pos_stock_reservations` for the register → closes any linked
     `pos_table_sessions`.
  8. Single PL/pgSQL body — atomic in Postgres unless an exception
     rolls it back.
- **Return / void / recall / cash / drawer / shift close / cashier PIN**
  live in `supabase/migrations/20260516124054_...sql` (return updated
  again in `20260530140301_...sql`).
  `process_pos_return` re-validates original transaction, computes
  returnable qty from view `v_pos_returnable_qty`, requires a reason,
  and does its own `stock_movements`/lot-consumption insert — i.e. it
  **duplicates** the item/payment/stock-posting logic of
  `process_pos_transaction`.
- **GL posting is not per-transaction.**
  `usePOSTransactionOffline.ts:136-139` documents: GL happens at shift
  close via trigger `trg_pos_shift_close_journal`
  (`supabase/migrations/20260427215308_...sql:49-58`) which calls
  `post_pos_shift_gl(_shift_id)`
  (`supabase/migrations/20260601140651_...sql`). This aggregates every
  `pos_transactions`/`pos_transaction_payments`/`pos_transaction_items`
  row for the shift into a single journal entry (revenue, COGS, tax,
  cash variance) and writes `journal_entry_id` back onto `pos_shifts`.
- **Events** — `business_event_outbox` (table created in
  `supabase/migrations/20260617124104_...sql:13`) is populated by DB
  triggers. `trg_pos_emit_payment_received` (latest
  `20260617213931_...sql`) fires on `pos_transaction_payments` insert
  — same transaction as the sale commit, so no dual-write risk for
  that event.
  `src/services/events/BusinessSaga.ts` drains the outbox via
  `claim_next_business_event` (`FOR UPDATE SKIP LOCKED`) and dispatches
  to handlers, retrying up to 10 attempts on handler failure.
- **Downstream financial docs** (`journal_entries`, `bank_transactions`,
  `mpesa_c2b`) are **not** produced at transaction commit for standard
  sales — only at shift close (GL), or via separate M-Pesa
  reconciliation flows (`src/components/pos/MpesaC2BLookupModal.tsx`,
  `src/hooks/pos/usePOSCreditSale.ts`, called client-side in
  `onSuccess` at `usePOSTransactionOffline.ts:120-128`).

---

## 2. Domain ownership & duplication

| Concern | Locations | Verdict / canonical owner |
|---|---|---|
| Basket math (subtotal/discount/tax/line total) | `src/hooks/pos/usePOSCart.ts:64-89` (`calculateItemTotals`, full formula, client-side) | **No server owner.** `process_pos_transaction` inserts `p_subtotal/p_tax_amount/p_discount_amount/p_total` and per-item `unit_price/tax_amount/line_total` verbatim from client JSON, with no server-side recomputation or cross-check (`process_pos_transaction` body, lines ~105-192). Client is the de facto and only source of truth for money math. |
| Pricing resolution (price lists, happy hour) | `src/hooks/pos/useHappyHour.ts`, `src/hooks/pos/usePOSProducts.ts`, `src/hooks/pos/usePOSProductCache.ts` — client reads pricing tables and applies into cart | RPC trusts `unit_price` as sent — no server re-derivation. |
| Tax resolution | `usePOSCart.ts` resolves `tax_rate` / `tax_rate_id` and computes `tax_amount` client-side; RPC stores `tax_rate_id`/`etims_tax_code` but does not re-derive from `tax_rates`/`tax_groups` | Trusts client tax math. |
| Inventory availability + reservation | Two parallel mechanisms: `pos_stock_reservations` (checked/deleted inside `process_pos_transaction`) vs. generic `stock_reservations` / `reserve_stock` / `release_stock` RPCs used by `src/hooks/pos/usePOSStockReservation.ts:8-58` | **Fragmented ownership** — a reservation via `reserve_stock` is invisible to the check inside `process_pos_transaction`, defeating the purpose of reservation. |
| Inventory movement post-commit | `process_pos_transaction` and `process_pos_return` independently insert into `stock_movements` and call `consume_lots_atomic` | **Duplicated** across two RPCs; no shared helper. |
| Financial posting (GL) | `post_pos_shift_gl` — single canonical function, called only from the shift-close trigger | Single owner — but see §3 for the coupling/availability risk. |
| Cash drawer & shift accounting | `pos_add_cash_movement`, `process_pos_drawer_event`, `close_pos_shift` (RPCs). Client hooks (`usePOSCashDrawer.ts`, `usePOSCashMovementTypes.ts`) are read/dispatch only; enforced by `src/test/architecture/no-client-pos-cash-writes.test.ts`, `no-client-pos-drawer-event-writes.test.ts`, `no-client-pos-shift-writes.test.ts` | RPC-owned with regression tests. Good. |

**Business logic that should be server-side but lives on the client**:

- All line-item pricing / discount / tax arithmetic (`usePOSCart.ts`).
- Credit-sale invoice creation timing (`usePOSTransactionOffline.ts:119-134`,
  fire-and-forget after commit, errors only logged).
- Client-derived `p_idempotency_key` fallback of `crypto.randomUUID()`
  when no key is supplied (`usePOSTransactionOffline.ts:245`) — silently
  defeats retry-collapse.

---

## 3. Transaction integrity

- **Atomicity** — single PL/pgSQL body → one Postgres transaction. A
  mid-function exception rolls back the whole insert set. Good.
- **Idempotency** — real guarantee is the replay-lookup on
  `(organization_id, business_id, register_id, idempotency_key)` plus a
  client-persisted key (`useCommitKey.ts`). Weakness: the key is
  optional (`p_idempotency_key text DEFAULT NULL`), and the online path
  falls back to `crypto.randomUUID()` in
  `usePOSTransactionOffline.ts:245` — a fresh random UUID on retry
  bypasses the replay check entirely. Offline path uses `queued.id`
  (`TransactionQueue.ts:188`), which is stable — safe.
- **Offline queue** — `syncTransaction`
  (`TransactionQueue.ts:135-236`) reuses the RPC with
  `p_idempotency_key: queued.id`, so a queued sale cannot double-post
  server-side. `syncAll` (`:241-275`) is serial with an in-memory
  `isSyncing` flag; if the tab crashes mid-sync, rows with
  `status: "syncing"` are stuck — no startup recovery pass is
  performed.
- **Duplicate-submission guard** — relies entirely on the
  client-persisted commit key. `useCommitKey.ts:53-55` acknowledges the
  private-browsing degradation. Contingent on `sessionStorage`
  availability.
- **Rollback on GL failure** — `trg_pos_shift_close_journal_fn`
  (`supabase/migrations/20260427215308_...sql:29-43`) wraps
  `post_pos_shift_gl` in `BEGIN/EXCEPTION`, logs to
  `pos_shift_close_errors`, then **re-raises**, rolling back the
  shift-close UPDATE. Sales inside the shift are not rolled back
  (they were committed hours/days earlier). GL failure cannot roll back
  inventory/sales because they are temporally and transactionally
  decoupled by design (Odoo-style session posting). Trade-off, not a
  bug — but a shift can accumulate sales/inventory movements with zero
  GL exposure until close succeeds.
- **Business event outbox** — emitted via DB trigger on
  `pos_transaction_payments` insert (same transaction as the commit)
  → no dual-write risk for `payment.received`. Consumption uses
  `FOR UPDATE SKIP LOCKED` claim + retry-to-10 → replay-safe by
  construction, contingent on handler idempotency.
- **Branch/session isolation** — `assert_pos_caller_branch_access`
  invoked in both `process_pos_transaction` and `process_pos_return`
  and enforced by `supabase/tests/pos_rpc_defense_in_depth_test.sql`.

---

## 4. Lifecycle completeness

| Stage | Implemented? | Where | Gap |
|---|---|---|---|
| Basket | Yes | `usePOSCart.ts` | — |
| Resolve price / promo / tax | Client only | `usePOSCart.ts`, `useHappyHour.ts`, `usePOSPromotions.ts` | No server-side re-derivation at commit |
| Availability check | Yes, weak | inside `process_pos_transaction` | Non-locking; two reservation systems |
| Reserve | Fragmented | `pos_stock_reservations` vs `reserve_stock` | Not unified; RPC only reads POS-specific table |
| Payment authorize | Partial | Inline tender-vs-applied check | No gateway/authorization step in-RPC; assumes payment captured client-side |
| Commit | Yes | `process_pos_transaction` | Trusts client totals |
| Receipt | Out of scope | — | — |
| Inventory movement | Yes | Inline in RPC | Duplicated in `process_pos_return` |
| GL post | Yes, deferred | `post_pos_shift_gl` at shift close | Long delay; failure blocks shift close |
| Analytics / audit | Partial | `snapshot` jsonb on `pos_transactions` | Not audited in depth |
| Close | Yes | `close_pos_shift` | — |

---

## 5. Event model

- `src/services/events/domainEventBus.ts:29` declares `'payment.received'`.
- DB trigger `trg_pos_emit_payment_received` writes to
  `business_event_outbox` at `pos_transaction_payments` insert — every
  sale commit that includes payments.
- `BusinessSaga.ts` polls/claims via `claim_next_business_event`
  (`FOR UPDATE SKIP LOCKED`), dispatches to handlers, completes with
  `complete_business_event(id, success, err)`. Failures retry up to
  10 attempts. Replayable and consumer-idempotent by design, contingent
  on handler idempotency (comment at `usePOSTransactionOffline.ts:150-152`
  claims hardware commands are keyed `pos-drawer:{tx}` /
  `pos-receipt:{tx}`).
- **Missing events**: no `sale.committed`, no `inventory.decremented`,
  no `journal.posted` in the outbox. Downstream systems needing to
  react to a sale (beyond hardware) must poll tables directly.

---

## 6. Ranked architectural risks

1. **Client-trusted money math with no server-side recomputation.**
   `process_pos_transaction` inserts `p_subtotal/p_tax_amount/p_total`
   and every line's `unit_price/tax_amount/line_total` as supplied by
   the client, while all arithmetic lives in `usePOSCart.ts:64-89`.
   A compromised/buggy client (or a crafted RPC call) can post any
   total to `pos_transactions`, then verbatim to the GL by
   `post_pos_shift_gl`. **Trust boundary / hidden coupling.**
2. **Dual, disconnected inventory reservation systems.**
   `pos_stock_reservations` vs `stock_reservations` / `reserve_stock`.
   A reservation through one path is invisible to the other →
   overselling risk. **Ownership boundary duplication.**
3. **Non-idempotent fallback for online commits.**
   `p_idempotency_key: data.idempotency_key || crypto.randomUUID()`
   (`usePOSTransactionOffline.ts:245`) silently disables
   replay-collapse whenever the commit-key hook cannot produce a key.
   **Non-idempotent design masquerading as idempotent.**
4. **Duplicated commit/posting logic across
   `process_pos_transaction` and `process_pos_return`.**
   Both independently implement item insert, stock-movement/lot
   consumption, and payment recording. **SRP / DRY.**
5. **Temporal decoupling between sale commit and GL exposure, with
   all-or-nothing shift close.** Sales post immediately to
   `pos_transactions`/inventory but are financially invisible until
   shift close, and any error thrown by `post_pos_shift_gl` (e.g. a
   missing account mapping) makes the *entire shift* unclosable
   (`trg_pos_shift_close_journal_fn` re-raises). **Hidden coupling
   between operational commit and financial close.**
6. **Non-locking stock availability check** inside
   `process_pos_transaction` — plain aggregate `SELECT`, no
   `FOR UPDATE`, between check and the later `stock_movements`
   insert. Concurrent terminals can both pass the check for the last
   unit. **Race condition / missing pessimistic locking.**

---

## Verdict

The engine has real strengths — a single atomic commit RPC, a genuine
(if leaky) idempotency mechanism, branch-isolation guards, architecture
tests preventing client-side writes to cash/drawer/shift tables, and a
well-designed claim-based event outbox. It is **not yet trustworthy as
the canonical retail transaction orchestrator** in its current form.
Blocking issues:

1. Server never validates or recomputes the money math it commits and
   later posts to the GL — the "ledger of record" is only as correct
   as the browser that submitted it.
2. Two independent, non-reconciled stock-reservation systems create
   overselling exposure.
3. The idempotency guarantee has a silent fallback that reintroduces
   the double-post risk it was built to prevent.
4. Return/void logic reimplements (rather than reuses) core posting
   logic, doubling the maintenance/drift surface.
5. GL posting failure at shift close can block operational shift
   handoff entirely.

These are addressed by ADR 0082 and batches T1–T7.
