
# Wave 2 — Checkout & Transaction Engine · Continuation Plan

## Status snapshot (updated after Phase F.1–F.5)

**Shipped & verified:** A · B · D · E-1 · C-1 · C-2 · **C-3 (all sub-phases)** · **E-2.1 · E-2.2** · **F.1 · F.2 · F.3 · F.4 · F.5**

**Currently active:** transitioning out of Phase F, into Phase G.

**Next milestone (start here):** **Phase F.6 — GL posting on `settlement.card.closed`** (see "Handoff" below), then Phase G.

**Deferred/re-scoped:** E-2.3 (bank-recon hint rows) — the existing `bank_reconciliation_items` table's FK points at `bank_transactions`, not at `pos_transaction_payments`. Rather than force-fit a POS row through it, the same signal is now produced natively by Phase F (`pos_card_settlements` → `settlement.card.closed` → GL). The E-2.3 sub-phase is retired; no action required.

## What is fully implemented and verified

### Phase C-3 — Card FSM completeness
- **C-3.1** `finalize_table_order` rewritten to route every restaurant payment through `_pos_record_payment` (FSM guard + catalog validation apply uniformly). `POSTerminal.tsx` restaurant branch forwards `auth_state / auth_id / vendor_txn_id / authorized_amount / card_last_four / card_type`.
- **C-3.2** `SQLiteSyncManager.pushPendingTransactions` posts each offline sale via `process_pos_transaction` (single-tx RPC). Local `tx.id` is reused as `p_idempotency_key`; card FSM + cash tender metadata forwarded. Direct `.insert()` on `pos_transactions*` removed.
- **C-3.3** New `src/components/pos/transaction-detail/CardPaymentActions.tsx` — Capture / Void / Reverse buttons keyed on `auth_state`; auto-hides Capture for `auth_capture` (single-message) rows; manager-PIN gate on Void / Reverse via `ManagerOverrideDialog`. Wired into `TransactionHistoryDialog`'s detail pane. Only uses `cardTerminal.*` — never touches `pos_card_*` RPCs directly.
- **C-3.4** DB trigger `trg_emit_pos_card_fsm_event` + function `tg_emit_pos_card_fsm_event` emit `payment.card.{authorized,captured,voided,reversed}` (server-scope) on `pos_transaction_payments.auth_state` transitions. Topics registered.
- **C-3.5** Arch guards extended in `src/test/architecture/pos-card-fsm.test.ts` (12 tests) + new `pos-offline-replay-uses-rpc.test.ts` (4 tests). All green.

### Phase E-2 — Downstream projections
- **E-2.1** `pos_sales_daily` + idempotent `project_pos_sale_committed(uuid)` RPC + dispatcher call.
- **E-2.2** `pos_customer_purchase_history` (UNIQUE(transaction_id)) + apply-log idempotency ledger (`pos_projection_apply_log`).
- **E-2.3** *Retired* (see snapshot).
- **E-2.4** Handler map coverage locked by `pos-outbox-handlers.test.ts` + dispatcher call to `project_pos_sale_committed`.

### Phase F — Settlement & Reconciliation (F.1–F.5)
- **F.1** `pos_card_settlements` — one row per acquirer batch. Unique index enforces one OPEN batch per `(business, branch, provider)`. RLS: business members read; writes RPC-only.
- **F.2** `pos_card_settlement_lines` — per-payment entries. Idempotent via `UNIQUE(payment_id, kind)` and `UNIQUE(source_event_id)`. `net = amount - fee`.
- **F.3** `pos_card_settlement_apply(event_id, payment_id, kind, amount, org_id, business_id, branch_id, provider_key)` — SECURITY DEFINER, service-role only. Opens a new batch if none open; rolls up `expected_amount` after every insert. Idempotent on `source_event_id` and `(payment_id, kind)`.
- **F.4** `pos_close_card_settlement(id, actual, notes)` — manager/admin gated (via `has_role`), freezes the batch, computes variance, inserts `settlement.card.closed` into `business_event_outbox`. UI page `src/pages/pos/CardSettlementReport.tsx` renders open batches + close dialog.
- **F.5** `outbox-dispatcher/index.ts` handlers: `payment.card.captured → apply(capture)`, `payment.card.reversed → apply(reversal)`, `settlement.card.closed → no-op (drains cleanly)`. Provider key resolved from `pos_payment_methods` catalog per payment.
- Arch guard `src/test/architecture/pos-card-settlement.test.ts` (5 tests): tables exist, RPCs exist, close RPC inserts `settlement.card.closed`, dispatcher wires both card topics, no src/ file writes to either settlement table. All green.

## What is still pending

### Phase F.6 — GL posting for closed settlements (**next up**)
Convert `settlement.card.closed` into a journal entry:
- Debit **Cash-in-Bank / Merchant Clearing** for `actual_amount`.
- Debit **Card Processing Fees** expense for `fee_total`.
- Credit **Card Clearing** (contra) for `expected_amount`.
- Route variance to **Cash short/over** on the difference.
- Handler lives in the dispatcher; posting must be idempotent keyed on `settlement_id`. Add a `pos_card_settlement_gl_apply_log` ledger row, or reuse the JE idempotency key pattern used elsewhere.
- Route the `CardSettlementReport` page into `App.tsx` under `/pos/settlements` (not wired yet).

### Phase G — Cash lifecycle & returns authorization
Untouched — spec below is unchanged from the prior revision.

- **G.1** Emit `pos.drawer.opened / .closed` (host-scope) and `pos.cash.drop.recorded / .variance.detected` (server-scope) from existing trigger surfaces. Handlers write cash-drop JE (Cash → Safe/Bank clearing) and variance JE (Cash short/over expense).
- **G.2** Blind vs open close in `pos_shift_close`; blind close records `actual = NULL` and requires manager reconciliation before the JE fires.
- **G.3** `pos_return_authorizations` FSM: `requested → approved → applied` (or `rejected`). Trigger emits `pos.return.authorized / .applied`. Handler writes reversing JE + inventory movement. Manager PIN gate at `approved`.
- **G.4** Arch guards: cash JEs originate only from the outbox handler; returns cannot post inventory movement without an `applied` authorization row.

## Cross-cutting hygiene (already applied, keep applying)
- Every new public-schema table ships with `GRANT` + RLS in the same migration.
- Every new outbox topic registered in `business_event_topics` with correct `handler_scope` + `max_attempts`.
- Every dispatcher handler is idempotent, keyed on `source_doc_id` or `event_id`.
- No secrets in DB; edge function secrets via `add_secret`.

## Execution order (remaining)
**F.6 → G.1 → G.2 → G.3 → G.4**

## Definition of done (unchanged)
- All existing POS arch guards remain green; new guards added per phase are green.
- `pos_transaction_payments.auth_state` is only ever written via `pos_card_*` RPCs.
- Restaurant + offline-replay sales are indistinguishable from retail sales at the DB level.
- Every card capture produces exactly one settlement line; every settlement close produces exactly one GL entry.
- Cash drawer opens/closes and returns produce complete audit trails via the outbox; no UI-only side effects remain in the checkout path.

---

## Handoff — instructions for the next agent

**Step 1 — Verify Phase F end-to-end before touching new work.**

1. Confirm the migration `Wave 2 · Phase F — Card Settlement & Reconciliation` is in `supabase/migrations/` and applied. Tables: `pos_card_settlements`, `pos_card_settlement_lines`. RPCs: `pos_card_settlement_apply`, `pos_close_card_settlement`.
2. Run `bunx vitest run src/test/architecture/pos-card-fsm.test.ts src/test/architecture/pos-card-settlement.test.ts src/test/architecture/pos-offline-replay-uses-rpc.test.ts` — should be **21 passed**.
3. Simulate a card capture in retail flow and check `pos_card_settlement_lines` has a new row with `kind='capture'`, correct `source_event_id`, and that `pos_card_settlements.expected_amount` matches SUM(net). Retry the same event via the dispatcher and confirm no duplicate line (idempotency on `source_event_id` + `(payment_id, kind)`).
4. Close the batch via `CardSettlementReport` as a manager and verify: `pos_card_settlements.status='closed'`, `variance = actual - expected`, and one row in `business_event_outbox` with `event_type='settlement.card.closed'`.
5. Confirm dispatcher no-ops `settlement.card.closed` for now (event completes successfully; no retries).
6. Only if all six checks pass, proceed to Phase F.6.

**Step 2 — Implement Phase F.6 (GL posting), then Phase G.1 (cash-drawer lifecycle events).** Do not jump to G.3 or G.4 before G.1/G.2 land — the JE side of cash needs the events first.

**Do not** open unrelated system work (payroll, banking, inventory reorder, etc.) while Phase G is in flight. The Wave 2 checkout engine must reach the "Definition of done" bullets above as a coherent whole.
