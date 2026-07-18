# Wave 2 — Checkout Engine · Continuation Plan

## Verification of prior work (Phase 1)

Confirmed against DB + filesystem, not the prior agent's claims:

- **Phase F.1–F.5 shipped as advertised.** `pos_card_settlements`, `pos_card_settlement_lines`, `pos_card_fsm_transitions`, `pos_cash_movements`, `pos_drawer_events`, `pos_shifts`, `pos_shift_close_errors` all exist in `public`. RPCs `pos_card_settlement_apply`, `pos_close_card_settlement`, `project_pos_sale_committed`, `claim_next_business_event`, `finalize_table_order`, `process_pos_transaction` all exist. Settlement migration `20260718220628…f055434a` present. `CardSettlementReport.tsx` exists. Arch guards `pos-card-fsm.test.ts`, `pos-card-settlement.test.ts`, `pos-offline-replay-uses-rpc.test.ts` present.
- **Real gaps to close before advancing:**
  1. `CardSettlementReport` is not routed anywhere in `App.tsx` / router. Managers can't reach it.
  2. `settlement.card.closed` is a dispatcher no-op — no GL entry is written yet (this is F.6, still pending as claimed).
  3. G.1–G.4 (cash JEs, blind close reconciliation, return authorization FSM, arch guards) are untouched.
- Before any new work, I will re-run the 21-test arch-guard suite listed in the handoff and simulate one capture → close → outbox flow. If any step fails, that becomes the first fix.

## Plan validation & expansion

Original F.6 + G.1–G.4 spec is sound. Additions from re-reading the parent prompt against the current code:

- **F.6a — routing + navigation entry.** Wire `/pos/settlements` into the POS router and add a nav item guarded by manager role; the report is useless if unreachable.
- **F.6b — GL idempotency ledger.** New `pos_card_settlement_gl_apply_log(settlement_id PK, journal_entry_id, applied_at)` so dispatcher retries never double-post. Reuses the same "apply log" pattern already used for `pos_projection_apply_log`.
- **G.0 — canonical outbox topics registered up front** (`pos.drawer.opened`, `pos.drawer.closed`, `pos.cash.drop.recorded`, `pos.cash.variance.detected`, `pos.return.authorized`, `pos.return.applied`) with correct `handler_scope` (`host` for drawer open/close, `server` for cash JE + returns) and `max_attempts`, so G.1–G.3 handlers have topics to bind to.
- **G.3 arch guard extension:** in addition to "no inventory movement without an `applied` authorization", also enforce that reversing JEs originate only from the dispatcher handler — mirrors the F.5 posture and prevents UI-only refund side effects.
- **Definition-of-done additions:** every new JE writes through `resolveDefaultAccount(business_id, purpose, branch_id)` (never a hard-coded account id), and every new outbox event uses `business_id`/`branch_id` scoping so multi-branch reporting remains correct.

## Execution order

`Verification → F.6 (a + b + core) → G.0 → G.1 → G.2 → G.3 → G.4`

Do not open unrelated systems (payroll, banking, reorder) mid-flight.

## Technical detail — F.6 (GL posting for closed settlements)

- **Trigger:** `settlement.card.closed` event in `business_event_outbox` (already emitted by `pos_close_card_settlement`).
- **New table:** `pos_card_settlement_gl_apply_log` with GRANT + RLS + `service_role` writes only.
- **New RPC (SECURITY DEFINER, service_role):** `pos_card_settlement_post_gl(p_settlement_id uuid)` — resolves accounts via `resolve_default_account` for purposes:
  - `pos_cash_in_bank_merchant_clearing` (Dr `actual_amount`)
  - `pos_card_processing_fees` (Dr `fee_total`)
  - `pos_card_clearing` (Cr `expected_amount`)
  - `pos_cash_short_over` (Dr/Cr `variance`)
  - Inserts one balanced `journal_entries` + `journal_entry_lines` set, scoped by `business_id`/`branch_id`; writes `pos_card_settlement_gl_apply_log(settlement_id)` in the same tx. On unique-violation of the log PK, exits idempotently.
- **Dispatcher (`outbox-dispatcher/index.ts`):** replace the current `settlement.card.closed` no-op with a call to `pos_card_settlement_post_gl(source_doc_id)`.
- **UI wiring:** register `/pos/settlements` route → `CardSettlementReport`; add a nav entry in `src/apps/pos/nav.ts` gated by manager/admin role.
- **Arch guards:** extend `pos-card-settlement.test.ts` with (a) apply-log table exists with unique settlement_id, (b) `pos_card_settlement_post_gl` exists, (c) dispatcher calls it for `settlement.card.closed`, (d) no `src/` file inserts into `journal_entries` for `source_module='pos_card_settlement'`.

## Technical detail — G. Cash lifecycle & returns authorization

- **G.0 — Topic registration.** Single migration that inserts the six outbox topics with correct scope/attempts and grants coverage to `pos-outbox-handlers.test.ts`.
- **G.1 — Cash-drawer + drop events + JEs.**
  - Triggers on `pos_drawer_events` and `pos_cash_movements` enqueue events (host-scope for open/close, server-scope for `cash.drop.recorded` and `cash.variance.detected`).
  - New RPC `pos_cash_drop_post_gl(event_id)` (SECURITY DEFINER): Dr `Safe/Bank clearing`, Cr `Cash on hand`, resolved via `resolve_default_account`. Idempotency via `pos_cash_gl_apply_log(source_event_id PK)`.
  - Variance handler posts to `pos_cash_short_over`.
- **G.2 — Blind vs open close.** Extend `pos_shift_close` to accept `p_mode = 'blind' | 'open'`. Blind close stores `actual_cash = NULL` and does not emit `cash.variance.detected`. A separate `pos_shift_reconcile(shift_id, actual, notes)` manager RPC (role-gated via `has_role`) sets the actual, computes variance, and emits the variance event that the G.1 handler will post.
- **G.3 — Return authorization FSM.**
  - New table `pos_return_authorizations(id, transaction_id, requested_by, approver_id, state, reason_code_id, manager_pin_verified_at, applied_at, …)` with allowed transitions `requested → approved → applied` and `requested → rejected`; state changes only via `pos_return_authorization_transition(id, to_state, manager_pin?)` RPC (manager PIN required to reach `approved`).
  - Trigger emits `pos.return.authorized` on `→ approved` and `pos.return.applied` on `→ applied`.
  - Dispatcher handlers: reversing JE (mirror of original sale postings, keyed on `authorization_id`) + inventory reversal via `recordStockMovements` with pack provenance. Idempotency via `pos_return_apply_log(authorization_id PK)`.
- **G.4 — Arch guards** (new `src/test/architecture/pos-cash-and-returns.test.ts`):
  - No `src/` file inserts into `journal_entries` for `source_module IN ('pos_cash','pos_return')`.
  - No `src/` file inserts into `stock_movements` referencing a return transaction without going through the return-authorization apply path.
  - All six G.0 topics are registered with the expected `handler_scope`.
  - Both new apply-log tables enforce PK on their idempotency column.

## Definition of done (unchanged bullets + additions)

- All existing POS arch guards remain green; new guards per phase are green.
- `pos_transaction_payments.auth_state` only ever written via `pos_card_*` RPCs.
- Restaurant + offline-replay sales are indistinguishable from retail at the DB level.
- Every card capture produces exactly one settlement line; every settlement close produces exactly one balanced JE (via apply-log).
- Cash drawer open/close, cash drops, variances, and returns all produce complete audit trails via the outbox; no UI-only side effects remain in the checkout or refund path.
- Every new JE resolves accounts through `resolve_default_account`; no hard-coded account ids in code or migrations.
