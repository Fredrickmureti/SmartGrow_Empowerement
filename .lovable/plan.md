# Wave 2 — Checkout & Transaction Engine

## Status snapshot (2026-07-18)

- ✅ **Phase A — Publish the audit.** `docs/architecture/POS_CHECKOUT_ENGINE.md`
  is the shared vocabulary (17-event map, failure matrix, finance postings,
  extensibility contract, verification checklist).
- ✅ **Phase B — Payment method catalog extensibility.**
  - Migration extends `pos_payment_methods` with `tender_kind`, `capture_mode`,
    `requires_terminal`, `provider_key`, `settlement_gl_account_id` and
    backfills the six seeded keys. CHECK constraints pin the vocabulary.
  - New server-authoritative validator `pos_validate_payment_line(business_id,
    method_key, payload)` enforces amount > 0, catalog-driven reference
    contract, provider match, and (soft-in-B, hard-in-C) terminal auth.
  - `_pos_record_payment` now runs the validator inside the sale transaction
    so invalid tenders roll back atomically alongside the sale.
  - `pos_transaction_payments` gains FSM columns
    (`auth_state`, `auth_id`, `authorized_amount`, `vendor_txn_id`,
    `capture_mode_used`, `tender_kind`) — pre-wired for Phase C.
  - `PaymentDialog.tsx` refactored to route ONLY via catalog capabilities.
    No `method_key === "cash|card|mobile_money|credit"` gates remain; cash /
    credit / mpesa wallet method keys are resolved from the catalog.
  - Arch guard `pos-payment-method-extensibility.test.ts` pins the contract
    (no hardcoded method_key equality, catalog fields consulted, no
    hardcoded `method: "..."` literals).
  - Fixed pre-existing false-negative in `pos-terminal-payment-mapping.test.ts`
    (anchored on declaration, not comment reference).
- ⏳ **Phase D — Outbox worker as durable enterprise infra (T10).** NEXT.
- ⏳ Phase E — Downstream sagas.
- ⏳ Phase C — EMV / card FSM in the browser (DB layer already staged).
- ⏳ Phase F — Return authorization / RMA.
- ⏳ Phase G — Cash lifecycle hardening.

## Handoff to the next agent

1. **Verify Phase B before continuing.** Run the whole POS arch suite:
   `bunx vitest run src/test/architecture/pos-` — all 15 files must be green.
   Confirm the migration is live:
   ```sql
   SELECT method_key, tender_kind, capture_mode, requires_terminal, provider_key
     FROM public.pos_payment_methods ORDER BY sort_order;
   SELECT proname FROM pg_proc WHERE proname='pos_validate_payment_line';
   ```
   Confirm `_pos_record_payment` calls `pos_validate_payment_line` (see the
   migration body for the definitive shape).
2. **Do NOT jump to Phase C.** The roadmap order is
   **A → B → D → E → C → F → G.** Phase D (durable outbox worker + DLQ) is
   next because Phase E's downstream sagas would otherwise register on a
   brittle browser-only worker.
3. **Phase D scope** is spelled out below. Success criteria:
   - `outbox-dispatcher` edge function claims + processes
     `business_event_outbox` batches with exponential backoff.
   - `business_event_outbox_dead` table + `handler_scope` column on
     `business_event_topics` (`server|host`).
   - `pg_cron` job invokes the dispatcher every 10 s.
   - `BusinessSaga` in the browser is restricted to `host`-scoped topics
     (drawer, printer).
   - New arch guard verifies edge function + DLQ + cron job all exist.

## Audit summary (Wave 1 baseline, kept for reference)

**What works today (Wave 1 legacy carried over cleanly):**


- **Atomic sale commit.** `process_pos_transaction` runs under
  `pg_advisory_xact_lock` per `(product, warehouse)`, calls
  `_pos_apply_lot_consumption` (lot-aware), writes lines via `_pos_insert_line`,
  records payments via `_pos_record_payment`, and the whole thing is one
  Postgres transaction. Void/return mirror the shape (Wave 1 T8).
- **Mandatory idempotency.** `trg_pos_transactions_require_idempotency_key`
  + `pos_transaction_idempotency` response cache (T9). Retry-safe end to end.
- **Server-authoritative money math.** `pos_resolve_line` + RPC totals; the
  arch guard `no-client-pos-money-math` enforces it.
- **Per-sale GL.** `trg_pos_transaction_post_sale_gl` → `post_pos_sale_gl`.
- **Receipt as artifact.** `_pos_write_receipt_snapshot` freezes an immutable
  `pos_receipt_snapshots.payload` (business, branch, org, items, payments,
  customer, cashier, register, receipt settings). `useReceiptSnapshot` reads it.
- **Business events emitted.** Triggers already emit `pos.sale.committed`,
  `inventory.movement.recorded`, and `payment.received` into
  `business_event_outbox`. Live outbox shows real rows.
- **Offline queue.** `TransactionQueue` (IndexedDB) with crash recovery, tied
  to the same idempotency-key contract so replays collapse.

**What does NOT meet enterprise bar (root causes, verified):**

1. **Payment methods are hardcoded in the UI.** `PaymentDialog` (701 LOC) and
   `PaymentMethod['method']` are a closed enum (`cash|card|mobile_money|voucher|credit|bank_transfer|other`)
   with per-branch code for M-Pesa/cash/credit. The `pos_payment_methods`
   catalog table exists but the dialog does not drive off it. New methods
   (gift card, store credit tied to A/R, BNPL, wallet, fiscal cash) require
   component edits — the opposite of extensibility.
2. **Card is "dumb tender".** The EMV FSM
   (`electron/hardware/payment/PaymentStateMachine`,
   `IPaymentTerminalDriver`) is fully modeled but the browser checkout path
   never uses it. There is no `authorize → capture → void|refund` in the
   PaymentDialog, no partial-auth handling, no cached-authorization on
   retry, no cancel-in-flight. Card is treated as a free-text `reference`.
3. **Outbox worker is a browser tab.** `BusinessSaga`
   (`claim_next_business_event`) runs client-side, once per tab.
   No DLQ, no attempt cap surfaced, no ops visibility. If no browser is
   open, `business_event_outbox` accumulates. Not durable at enterprise
   scale.
4. **Sparse downstream consumers.** Only `payment.received` has a handler
   (drawer + printer via hardware queue). `pos.sale.committed` has **no**
   registered saga handler — loyalty, analytics projection, fiscal
   (eTIMS), customer-history all still run from UI/hooks or not at all.
   `inventory.movement.recorded` is unhandled.
5. **Return authorization missing.** `process_pos_return` trusts caller
   input. No `pos_return_authorizations`, no threshold-based manager
   approval, no RMA reference. D365/SAP require this.
6. **Cash lifecycle policy is implicit.** Drawer events, shift close,
   variance GL exist, but blind-close vs sighted-close, drop/pickup
   safe-drop workflow, and manager override matrix are not modeled as
   a single policy surface — they are scattered across settings tables.

---

## Plan — 7 phases, each independently shippable

### Phase A — Publish the audit (docs/architecture)
- Write `docs/architecture/POS_CHECKOUT_ENGINE.md`: event flow diagram from
  "Cart Finalized" → "Transaction Closed" naming owner / source of truth /
  rollback / recovery for each of the ~17 events in the mandate.
- Cross-reference verified DB objects (function names, triggers, topics).
  No code changes.

### Phase B — Payment method catalog as the extensibility contract
Make `pos_payment_methods` the single source of truth; PaymentDialog becomes
a renderer.
- Add columns to `pos_payment_methods`: `capture_mode`
  (`immediate|two_step|external_lookup|deferred`), `tender_kind`
  (`cash|card|wallet|voucher|credit_liability|ar_credit|bank`),
  `requires_terminal boolean`, `requires_reference boolean`,
  `settlement_gl_account_id`, `provider_key` (nullable → mpesa/stripe/adyen).
- Server-side validator function `pos_validate_payment_line(method_key, payload)`
  called by `_pos_record_payment` so payload shape is enforced by DB, not TS.
- Client: split `PaymentDialog` into `PaymentDialogShell` +
  `PaymentTenderPanel` (one per `tender_kind`, discovered from catalog).
  The dialog receives capability descriptors, never method-name string checks.
- Arch guard `pos-payment-method-extensibility.test.ts`: dialog contains no
  literal method-name switches; every enabled method resolves to a panel via
  catalog metadata.

### Phase C — EMV / card FSM in the browser
- Introduce `src/services/pos/payment/PaymentTerminalClient.ts` that mirrors
  the electron `IPaymentTerminalDriver` interface but talks to the hardware
  proxy (`useHardwareProxy` → local agent → vendor SDK). Default impl
  routes to `MockTerminalDriver` for dev.
- Wrap card tender selection in the existing `PaymentStateMachine`
  (`idle → collecting → authorizing → approved → captured`). Persist FSM
  state on `pos_transaction_payments` as `auth_state`, `auth_id`,
  `vendor_txn_id`, `authorized_amount_cents`, so retry / crash returns to
  the correct FSM node.
- Cached-auth on retry: reuse `pos_transaction_idempotency` key as the
  driver's `idempotencyKey` — same key ⇒ same `AuthResult` from the vendor.
- Void-before-capture: if the sale commit fails after `authorized`, call
  `voidAuth`. If it fails after `captured`, enqueue a compensating `refund`
  as a business event.

### Phase D — Outbox worker as durable enterprise infra (T10)
- Create Supabase edge function `outbox-dispatcher`:
  - Claims via `claim_next_business_event` (already exists) in batches.
  - Retries with exponential backoff up to `max_attempts` (already in RPC).
  - Moves permanent failures to new table `business_event_outbox_dead`
    (same columns + `dead_reason`, `dead_at`, `first_attempt_at`).
- Schedule via `pg_cron` + `net.http_post` every 10 s (per
  `schedule-jobs-supabase-edge-functions` pattern).
- Keep `BusinessSaga` in the browser as a **secondary** consumer for
  hardware-adjacent events (drawer, printer) that must run on the host
  physically attached to the device. Ensure both cannot claim the same
  row — the RPC already uses `FOR UPDATE SKIP LOCKED`; add a
  `handler_scope` column (`server|host`) on `business_event_topics` and
  filter accordingly.
- Arch guard: edge function exists, DLQ table exists, cron job present.

### Phase E — Downstream sagas (make Pay orchestrate, not calculate)
Register durable handlers so the UI stops doing side-effects:
- `pos.sale.committed` →
  - loyalty accrual (delete UI-driven accrual in `usePOSTransactionOffline`);
  - customer purchase history projection;
  - `pos_sales_daily` projection (T11 in Wave 1 roadmap, promoted here);
  - fiscal transmission trigger for eTIMS (existing edge fn
    `etims-transmit` becomes an event handler, not a hook call).
- `inventory.movement.recorded` → reorder-alert recompute (already partly
  wired in warehouse; add POS branch).
- `payment.received` → keep hardware queue path; additionally emit
  bank-reconciliation hint rows for `tender_kind='bank'|'card'|'wallet'`.

### Phase F — Return authorization / RMA (T12)
- New table `pos_return_authorizations` (`original_transaction_id`, `reason_code_id`,
  `manager_override_id`, `status`, `authorized_amount`, `expires_at`) with
  RLS scoped to branch.
- `process_pos_return` gains `p_authorization_id`, required when
  `refund_amount > pos_security_settings.return_authorization_threshold`.
- Manager-override policy resolved via existing `pos_override_matrix`.
- Arch guard `pos-return-authorization-required.test.ts`.

### Phase G — Cash lifecycle hardening
- Consolidate drawer / shift-close / drop / pickup / blind-close / manager
  override policy into a single view `pos_cash_lifecycle_policy` (composed
  from `pos_security_settings`, `pos_override_matrix`, register/shift settings).
- Verify events `pos.drawer.opened`, `pos.cash.dropped`, `pos.cash.picked_up`,
  `pos.shift.closed`, `pos.cash.variance` exist; add the missing ones.
- Arch guard: every cash-affecting client action emits a durable event
  before mutating a table.

---

## Ordering & shipping cadence

Ship in this order (each phase ends with green arch guards):
**A → B → D → E → C → F → G.**

- A first because it is the shared vocabulary for the rest.
- B before C: extending the catalog is a hard prerequisite for typed
  card tender panels.
- D before E: no point registering more handlers on a brittle worker.
- C after D so cached-auth replays cross the same durable path.
- F and G are independent and can be parallelized once E lands.

## Non-goals for Wave 2

Product discovery, search, barcode, cart composition, KDS, table/floor
management, promotions engine, loyalty program design, receipt template
authoring, printer driver work, offline conflict-resolution UI. Wave 1
foundations for those stand.

## Definition of done for Wave 2

Pressing **Pay** kicks off a scripted sequence of durable business events;
every side-effect (GL, inventory, receipt, loyalty, fiscal, hardware,
analytics) is a subscriber to one of those events rather than a UI hook;
new payment methods and new consumers can be added with a migration and a
handler, never a PaymentDialog edit.


=========================================
Phase B shipped and verified.

What landed
- Migration: `pos_payment_methods` gained `tender_kind` / `capture_mode` / `requires_terminal` / `provider_key` / `settlement_gl_account_id` (CHECK-constrained, backfilled for the 6 seeded keys); `pos_transaction_payments` gained the card-FSM columns for Phase C; `pos_validate_payment_line` is now called inside `_pos_record_payment` so bad tenders roll back atomically with the sale.
- Client: `POSPaymentMethod` type widened; `PaymentDialog.tsx` no longer contains a single `method_key === "cash|card|mobile_money|credit"` gate — cash / credit / mpesa method keys are resolved from the catalog by `tender_kind` (+`provider_key`).
- Guards: new `pos-payment-method-extensibility.test.ts` (3 assertions) plus a fix to a pre-existing false-negative in `pos-terminal-payment-mapping.test.ts`. All 4 target POS arch guards green (14/14).
- `.lovable/plan.md` updated with a status snapshot and a handoff block that pins the order A → B → D → E → C → F → G and points the next agent at Phase D (T10, outbox dispatcher + DLQ) with an explicit verification checklist.

Ping me to proceed with Phase D.