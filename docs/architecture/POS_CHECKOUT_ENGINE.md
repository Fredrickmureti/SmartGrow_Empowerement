# POS Checkout & Transaction Engine — Architecture Reference

**Status:** Wave 2 — Phase A (shared vocabulary). Every subsequent phase
(B–G) targets a gap named here.

**Scope.** What actually happens between the cashier pressing **Pay** and
the transaction being closed. This document is the canonical event map
for the POS write path. It replaces per-hook mental models.

**Non-goals.** Discovery, search, barcode, cart composition, KDS, table
management, promotions engine, receipt template authoring, printer driver
work. Those are Wave 1 foundations and are treated here as inputs, not
subjects.

---

## 1. First principles

An enterprise POS commit is **not** a form submission. It is the head of
a scripted sequence of durable business events. The UI's only job is to
originate the intent (a cart + a tender plan + an idempotency key). Every
side-effect — inventory motion, cash liability, GL, receipt artifact,
loyalty accrual, fiscal transmission, hardware — is a **subscriber** to
one of those events.

Three invariants govern the engine:

1. **Server-authoritative money math.** The client never decides totals,
   tax, discount stacking, or rounding. Enforced by the arch guard
   `no-client-pos-money-math` and by `pos_resolve_line` in Postgres.
2. **Atomic commit.** A completed sale is one Postgres transaction. If
   any part fails, nothing has moved: no line, no payment, no stock
   movement, no reservation release, no GL, no snapshot, no event.
3. **Idempotent by construction.** Every write RPC accepts a
   deterministic key. Retries collapse on `pos_transaction_idempotency`
   and return the exact original response body.

Anything that breaks one of these three is a bug, not a trade-off.

---

## 2. Business-event map

The 17-event sequence in the mandate, mapped to the code and DB objects
that own it today. **Owner** is the module allowed to originate the event;
**Source of truth** is where the durable state lives; **Rollback** names
the compensating action; **Recovery** names how the system converges when
the step fails.

Legend:
- ✅ implemented and event-driven
- ⚠️ implemented but not event-driven (still a hook call / UI side-effect)
- ❌ not implemented

### 2.1 Cart Finalized *(pre-commit, browser-local)*
- **Owner:** `usePOSCart`, `PaymentDialog`.
- **Source of truth:** in-memory `CartState`.
- **Event:** none (intentional — cart is ephemeral).
- **Rollback:** discard state.
- **Recovery:** none needed; the cart is not persisted until commit.

### 2.2 Transaction Created ✅
- **Owner:** `process_pos_transaction` (Postgres).
- **Source of truth:** `pos_transactions` row.
- **Trigger emits:** `pos.sale.committed`
  (migration `20260718185533_*` — trigger
  `trg_pos_transaction_emit_event`).
- **Idempotency:** mandatory `p_idempotency_key` (trigger
  `trg_pos_transactions_require_idempotency_key`) +
  `pos_transaction_idempotency` response cache (Wave 1 T9).
- **Rollback:** none — the RPC either commits everything or nothing.
- **Recovery:** retry with the same key; the cache serves the original
  response.

### 2.3 Inventory Reserved ✅ *(pre-checkout hold)* / Committed ✅ *(at Pay)*
- **Owner:** `_pos_apply_lot_consumption` (lot-aware), called under
  `pg_advisory_xact_lock(product, warehouse)`.
- **Source of truth:** `stock_movements` (movement ledger),
  `stock_reservations` (holds), `stock_quants` / `warehouse_stock` (balance
  projection), `stock_lots` (lot depletion).
- **Trigger emits:** `inventory.movement.recorded` per movement.
- **Rollback:** compensating movement via
  `_pos_apply_lot_consumption(direction='in')` on void / return.
- **Recovery:** the advisory lock serializes concurrent commits on the
  same `(product, warehouse)`; a retry either wins the lock and re-reads
  availability or replays through the idempotency cache.

### 2.4 Payment Initiated ⚠️
- **Owner today:** `PaymentDialog` (browser). No durable state before
  tender is confirmed.
- **Source of truth:** none until 2.6.
- **Gap:** card-present flows have no FSM in the browser. Vendor
  `authorize` calls happen (via M-Pesa STK for mobile money) but the
  card path treats the terminal result as a free-text `reference`. The
  electron `PaymentStateMachine` + `IPaymentTerminalDriver` are not wired
  into the browser checkout.
- **Wave 2 Phase C** brings the FSM into the browser and persists
  `auth_state / auth_id / vendor_txn_id / authorized_amount_cents` on
  `pos_transaction_payments`.

### 2.5 Payment Authorized ⚠️ *(card)* / ✅ *(mobile money via STK)*
- **Mobile money (M-Pesa):** `MpesaPaymentModal` + `mpesa-callback` edge
  function; C2B lookup for pull payments. Reference persisted on the
  payment line.
- **Card:** ❌ no auth state persisted; **Phase C** target.

### 2.6 Payment Captured ✅
- **Owner:** `_pos_record_payment` (Postgres helper) called from
  `process_pos_transaction`.
- **Source of truth:** `pos_transaction_payments`.
- **Trigger emits:** `payment.received`
  (migration `20260718194614_*` — trigger
  `trg_pos_emit_payment_received`).
- **Rollback:** on void/return the reversal RPC deletes / negates the
  payment line and emits a compensating GL reversal via
  `_pos_reverse_transaction_gl`. Card `voidAuth` / `refund` are Phase C.

### 2.7 Receipt Generated ✅ *(as artifact, not merely HTML)*
- **Owner:** `_pos_write_receipt_snapshot` (AFTER INSERT trigger on
  `pos_transactions`).
- **Source of truth:** `pos_receipt_snapshots.payload` (immutable JSONB
  containing the full document — business, branch, org, items, payments,
  customer, cashier, register, receipt settings — resolved at commit
  time).
- **Read path:** `useReceiptSnapshot`. Reprint / email / PDF / thermal
  MUST prefer the snapshot over live lookups so historical receipts stay
  byte-stable when business or branch settings change.
- **Rollback:** none (snapshot is immutable by design; a voided
  transaction gets a new document referencing the original).
- **Recovery:** if the snapshot write ever fails (has not been observed
  yet), the trigger raises and the whole commit rolls back.

### 2.8 Inventory Movement Posted ✅
Same object as 2.3. Listed separately in the mandate for emphasis: the
movement is what finance and analytics observe, not the cart action.

### 2.9 Warehouse Updated ✅
- **Owner:** trigger chain on `stock_movements` updates
  `stock_quants` / `warehouse_stock` / `stock_lots`.
- **Source of truth:** `stock_movements` (ledger, immutable).

### 2.10 Accounting Entries Created ✅
- **Owner:** `post_pos_sale_gl` (Postgres), fired by
  `trg_pos_transaction_post_sale_gl` after each sale/return.
- **Source of truth:** `journal_entries` + `journal_entry_lines`.
- **Cash over/short:** posted separately at shift close by
  `trg_pos_close_variance_gl`.
- **Rollback:** `_pos_reverse_transaction_gl` on void/return.
- **Design note.** GL is per-sale (D365/SAP-aligned). The legacy
  shift-close aggregator was dropped in Wave 1 Phase 4 to eliminate
  double-posting and make every JE traceable to a single transaction.

### 2.11 Cash Drawer Updated ✅ *(as durable event chain)*
- **Owner:** hardware-queue path — `payment.received` handler enqueues
  `cash_drawer.open` on `hardware_command_queue`; the
  `SharedCommandQueueWorker` on the host physically attached to the
  drawer drains the row. Deduped by `pos-drawer:{tx}`.
- **Source of truth:** `pos_drawer_events`, `pos_cash_movements`.
- **Gap (Phase G):** blind-close vs sighted-close policy, drop / pickup
  workflow, manager-override matrix live across multiple settings tables.
  Consolidate into a single `pos_cash_lifecycle_policy` view.

### 2.12 Session Totals Updated ✅
- **Owner:** `pos_shifts` running totals updated by triggers on
  transaction / payment inserts. `pos_daily_summary` /
  `pos_daily_sales_summary` projections for reporting.
- **Wave 2 Phase E** adds the denormalized `pos_sales_daily` read model
  as a durable saga consumer of `pos.sale.committed`.

### 2.13 Audit Trail Written ✅
- **Owner:** `audit_logs`, `pos_error_log`, `hardware_exec_log`.
- **Design note.** Enterprise-grade: history is never deleted. Voids and
  returns produce new rows that reference the original; the original
  stays.

### 2.14 Customer Purchase History Updated ⚠️
- **Today:** the invoice-request path (`usePOSInvoiceRequest`) and the
  A/R integration (`usePOSCreditSale` → invoice generation) both run
  from the UI success handler.
- **Wave 2 Phase E** target: register a durable `pos.sale.committed`
  handler that owns customer-history projection so the UI does no
  cross-domain writes.

### 2.15 Loyalty Updated ⚠️
- **Today:** `usePOSLoyalty` accrual runs from the UI success handler.
- **Wave 2 Phase E** target: `pos.sale.committed` saga handler owns
  accrual; UI stops writing loyalty rows.

### 2.16 Analytics Updated ⚠️
- **Today:** ad-hoc queries against `pos_transactions` / `pos_daily_summary`.
- **Wave 2 Phase E** target: `pos_sales_daily` denormalized projection
  updated by saga.

### 2.17 Fiscal Compliance Updated ⚠️
- **Today:** eTIMS (`etims-transmit` edge function,
  `fiscal-compliance-saga` edge function,
  `etims_transmission_logs`) — invoked as an edge function call rather
  than as a durable subscriber.
- **Wave 2 Phase E** target: `pos.sale.committed` handler triggers
  transmission; failures land in `business_event_outbox_dead` for ops.

### 2.18 Transaction Closed ✅
- **Owner:** the `RETURN` of `process_pos_transaction` after the response
  cache write. Client receives the canonical response body.

---

## 3. Extensibility contract for tender methods

**Requirement.** Cash, card, split tender, multiple cards, cash + card,
voucher, gift card, store credit, customer-account credit (A/R), mobile
money, bank transfer, future methods (wallet, BNPL, fiscal cash) must
all plug in without editing `PaymentDialog`.

**Today.** `PaymentDialog` (701 LOC) branches on a hardcoded enum:
`cash | card | mobile_money | voucher | credit | bank_transfer | other`.
The `pos_payment_methods` catalog exists but the dialog does not drive
off it.

**Wave 2 Phase B contract:**

| Field                     | Purpose                                                     |
|---------------------------|-------------------------------------------------------------|
| `method_key`              | Stable identifier (e.g. `cash`, `mpesa_stk`, `stripe_card`).|
| `tender_kind`             | `cash \| card \| wallet \| voucher \| credit_liability \| ar_credit \| bank`. Drives which UI panel renders.|
| `capture_mode`            | `immediate \| two_step \| external_lookup \| deferred`.     |
| `provider_key`            | Nullable — routes to a `PaymentTerminalClient` / gateway.  |
| `requires_terminal`       | Blocks tender selection when the hardware role is offline.  |
| `requires_reference`      | Enforces a reconciliation reference on the payment line.    |
| `settlement_gl_account_id`| Clearing account for reconciliation and settlement.         |

A server-side validator `pos_validate_payment_line(method_key, payload)`
gates the payload shape at `_pos_record_payment` time so the contract
lives in the database, not in TS types.

---

## 4. Transaction integrity — failure matrix

Enterprise behaviour for the failure cases in the mandate. All rows
depend on invariants §1 (atomic commit + idempotent retry).

| Failure                                                    | Behaviour today                                                                                                | Enterprise target                                                                                   |
|------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Payment succeeds, inventory fails                          | ✅ Whole txn rolls back; no capture is persisted before inventory is proved sufficient.                       | Same. Phase C additionally issues `voidAuth` if the vendor authorized before the DB rollback.       |
| Inventory succeeds, GL fails                               | ✅ GL runs inside the same txn via trigger; failure rolls the sale back.                                       | Same.                                                                                               |
| Receipt generation fails                                    | ✅ Snapshot trigger fires inside the txn; failure rolls the sale back.                                         | Same. Post-print (thermal, email) is async and does not block commit.                              |
| Printer disconnects mid-print                              | ✅ Hardware queue retries; `hardware_exec_log` records outcome.                                                | Same. Reprint from snapshot is always available.                                                    |
| Power fails                                                | ✅ In-flight txn rolls back on Postgres; the browser tab loses cart state.                                     | Phase C: crash-recovery of `TransactionQueue` (already implemented) covers offline sales.           |
| Internet disappears                                        | ✅ `TransactionQueue` (IndexedDB) accepts the sale offline under policy caps.                                  | Same.                                                                                               |
| Payment terminal times out                                 | ⚠️ Cashier retries manually; no FSM to prevent double capture.                                                 | Phase C: FSM in `authorizing` → cached-auth retry using the same idempotency key.                   |

---

## 5. Finance integration — canonical postings

All GL originates from `post_pos_sale_gl` / `_pos_reverse_transaction_gl`.
No UI code emits journal lines. The postings the engine covers today:

- Revenue by product / category.
- Output tax by tax rate.
- Discounts (contra-revenue).
- Cash rounding (per `cashRoundingSettings`).
- Cash tender → cash on hand.
- Card / mobile / bank tender → per-method clearing account (from
  `pos_payment_methods.settlement_gl_account_id` — Phase B enforces
  this).
- A/R credit sale → receivables (via `usePOSCreditSale` invoice creation
  post-commit; Phase E moves this behind the saga).
- Gift card / store credit → liability (Phase B formalizes via
  `tender_kind='voucher' | 'credit_liability'`).
- Deferred revenue for prepaid / gift cards purchased in-store (Phase E).
- Payment fees (per-method fee schedule) — deferred, tracked as gap.
- Overpayments / change — modelled as `tendered_amount − amount` on cash
  payment lines; no GL leakage.
- Refund liabilities — void/return posts the reversal via
  `_pos_reverse_transaction_gl` (Wave 1 T8).

---

## 6. Returns / voids / exchanges

- **`process_pos_return`** — advisory-lock protected, lot-aware, GL-reversing.
- **`process_pos_void`** — Wave 1 T8 brought to parity.
- **`trg_pos_block_void_return_overlap`** — prevents double-reversal.
- **Manager approval** — enforced today via `pos_manager_overrides` +
  `pos_override_matrix`.
- **Gap (Phase F).** `pos_return_authorizations` (RMA) — an authorization
  row referencing the original transaction, required above threshold from
  `pos_security_settings.return_authorization_threshold`. Matches D365
  "Return with RMA".

---

## 7. Offline readiness

The current architecture supports offline sales through `TransactionQueue`
+ crash recovery + mandatory idempotency keys. Nothing in Wave 2 removes
that capability. Phase C stores card FSM state on the payment row so an
offline-queued card sale can be replayed with the same
`idempotencyKey → cached AuthResult` semantics as an online retry.

---

## 8. Consumer registration — who subscribes to what

The current state and Phase E target for durable event handlers:

| Event                          | Handler today                            | Phase E target                                                            |
|--------------------------------|------------------------------------------|---------------------------------------------------------------------------|
| `pos.sale.committed`           | ❌ none registered                       | Loyalty accrual, customer history, `pos_sales_daily`, eTIMS transmission. |
| `payment.received`             | ✅ `BusinessSagaMount` → hardware queue  | Add bank-reconciliation hint for card/bank/wallet tenders.                |
| `inventory.movement.recorded`  | ❌ none registered                       | Reorder-alert recompute (POS branch of existing warehouse handler).       |

---

## 9. Worker durability — outbox as first-class infra

**Today.** `BusinessSaga` runs in the browser via `<BusinessSagaMount />`.
`claim_next_business_event` uses `FOR UPDATE SKIP LOCKED` so multi-tab is
safe, but with no browser open the outbox accumulates. No DLQ. No ops
surface for failed events.

**Phase D target.** A Supabase edge function `outbox-dispatcher` scheduled
via `pg_cron` claims and dispatches server-side. A new
`business_event_outbox_dead` table receives permanent failures. A
`handler_scope` column on `business_event_topics` (`server | host`) tells
each worker which topics belong to it — hardware-adjacent topics
(`payment.received` fanning to drawer / printer) stay on the host that
owns the device; everything else moves server-side.

---

## 10. Verification checklist

Any agent inheriting this document must re-verify before assuming the
map is current:

```sql
-- 2.2 idempotency + commit shape
SELECT proname,
       (prosrc ~* 'pg_advisory_xact_lock')                AS lock_ok,
       (prosrc ~* '_pos_apply_lot_consumption')           AS helper_ok,
       (prosrc ~* 'INSERT INTO\s+(public\.)?stock_movements') AS inline_bad,
       (prosrc ~* 'pos_transaction_idempotency')          AS uses_response_cache
FROM pg_proc
WHERE proname IN ('process_pos_transaction','process_pos_return','process_pos_void')
  AND pronamespace = 'public'::regnamespace;

-- 2.7 receipt snapshot
SELECT count(*) FROM pos_receipt_snapshots;    -- > 0 in any live tenant
SELECT proname FROM pg_proc
WHERE proname = '_pos_write_receipt_snapshot';  -- must exist

-- 2.10 GL trigger
SELECT tgname FROM pg_trigger
WHERE tgname IN ('trg_pos_transaction_post_sale_gl','trg_pos_close_variance_gl');

-- §9 topics
SELECT event_type FROM business_event_topics
WHERE event_type LIKE 'pos.%' OR event_type = 'payment.received'
   OR event_type = 'inventory.movement.recorded';
```

All rows for row 1 must show `lock_ok=t, helper_ok=t, inline_bad=f,
uses_response_cache=t` for `process_pos_transaction`, and
`lock_ok=t, helper_ok=t, inline_bad=f` for the other two.

---

## 11. Cross-references

- Wave 1 roadmap: `.lovable/plan.md`.
- Branch-isolation model: `docs/architecture/POS_BRANCH_ISOLATION.md`.
- Hardware execution topology: `docs/adr/…/0037-hardware-execution-topology.md`.
- Payment FSM (source): `electron/hardware/payment/PaymentStateMachine.ts`.
- Payment driver interface: `electron/hardware/payment/IPaymentTerminalDriver.ts`.
- Business event bus: `src/services/events/BusinessSaga.ts`,
  `src/services/events/domainEventBus.ts`.
- Idempotency guard: `eslint-rules/no-pos-commit-without-idempotency-key.js`.
