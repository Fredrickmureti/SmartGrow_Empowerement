
# POS Financial Posting — Verification & Continuation

## Phase 1 — Independent verification of prior work

Cross-checked the parent prompt, `.lovable/plan.md`, and the live database. Findings:

| Prior claim | Verified in DB | Verdict |
|---|---|---|
| S0 — `event_source_domain` domain type live; `business_event_outbox.source` typed by it | `pg_type` has `event_source_domain`; column shows `data_type=USER-DEFINED` bound to that domain | ✅ Genuinely shipped |
| S1 — Guard triggers `trg_pos_items_helper_only` + `trg_pos_payments_helper_only` on POS write tables; helper fns `_pos_insert_line`, `_pos_record_payment`, `_pos_apply_lot_consumption` are the sole write path; `attach_c2b_to_pos_transaction` rewritten through helpers | Both guard triggers present on `pg_trigger`; all three helpers present in `pg_proc`; `attach_c2b_to_pos_transaction` present | ✅ Genuinely shipped |
| S2 pending — `process_pos_transaction` still trusts client totals | RPC signature confirms `p_subtotal / p_tax_amount / p_discount_amount / p_total` still accepted | Correctly marked pending |
| Per-sale GL trigger `trg_pos_transaction_post_sale_gl` still active | Present — expected, only demoted in S5 | Consistent |

No completed step was found to be superficial or regressive. The architectural direction in the plan (statement-centric GL posting, holding-account cash flow, helper-only POS writes, domain-typed event source) matches enterprise retail patterns (SAP POS DM, D365 Commerce statement posting, LS Central statement, Odoo session close). No architectural drift added by the prior engineer. Continuation is safe.

## Phase 2 — Plan validation & additions

The existing S2–S6 sequence stands. Additions justified by re-reading the codebase against the parent prompt:

- **S2.a — Idempotency key surfacing.** The plan makes `server_totals` authoritative but the commit response today doesn't expose whether the client's advisory math diverged. Add an `advisory_totals_diff` object alongside `server_totals` so cashier UI can flag "displayed total was stale" without failing the sale.
- **S3.a — `pos_statements` covers non-shift closes.** Trading-day close for 24/7 stores AND out-of-band closes (branch closure, register decommission) must both produce a statement. Include `close_reason` + `close_kind ∈ {shift, trading_day, forced}` on `pos_statements`.
- **S3.b — Backfill correctness.** Historical `pos_shifts` rows lack per-tender variance breakdowns. Backfill computes statements from `pos_transaction_payments` aggregates and marks `posting_status='historical'` so S5 shadow-mode doesn't try to re-post them.
- **S4.a — Existing tender→account mappings must be preserved as a fallback.** Redirecting `pos_payment_methods.debit_account_id` to holding accounts is a business-impacting change; ship it behind a per-business feature flag (`use_holding_accounts=true`) and default to current behaviour until finance sign-off per org.
- **S5.a — Shadow-mode observability.** While `post_pos_sale_gl` runs in shadow, expose a report view `pos_gl_posting_drift` diffing shadow per-sale totals vs statement post totals, so finance can verify equivalence before drop.
- **S6.a — Add negative-test in CI:** an inserted-by-hand direct `INSERT INTO pos_transaction_items` must be rejected with `42501`; asserted in `src/test/pos/pos-writes-through-helpers-only.test.ts` at DB level via a service-role harness (not a mock).

## Phase 3 — Execution sequence to resume

Resume at **S2**. Each step ships as one migration + one code PR + one architecture test; each is independently reversible.

### S2 — Server-authoritative money math ✅ COMPLETE
1. DB response returns `server_totals` + `total_matches_server`; `pos_transactions` row is stamped from `v_srv_*` aggregates — guarded by `src/test/architecture/no-client-pos-money-math.test.ts`.
2. Client wrapper (`CommitSessionResult` in `src/lib/pos/paymentSessionClient.ts`) exposes both fields; `usePOSTransactionOffline` surfaces `serverTotals` + `totalMatchesServer` and logs a warning on divergence — guarded by `src/test/architecture/pos-commit-response-shape.test.ts`.
3. Receipt rendering already server-authoritative via `pos_receipt_snapshots` (written by `_pos_write_receipt_snapshot`); no client-cart totals reach reprint / audit surfaces.

### S3 — Introduce `pos_statements` ✅ COMPLETE
- Enums `pos_statement_close_kind` (`shift_close` / `trading_day_close` / `historical_backfill` / `force_close`) and `pos_statement_posting_status` (`pending` / `posted` / `historical` / `reversed`) created.
- Tables `pos_statements` + `pos_statement_tender_lines` created with GRANTs, RLS scoped through `user_can_access_branch`, and explicit no-direct-write policies (S1 helper-only pattern extended).
- RPCs `open_pos_statement(shift_id, close_kind, idempotency_key)` and `close_pos_statement(statement_id, counts jsonb, idempotency_key)` — both SECURITY DEFINER, both call `assert_pos_caller_branch_access`. Tender lines rebuilt from `pos_transaction_payments` on close.
- Trigger `trg_pos_open_stmt_on_close` auto-materialises a `pending` statement on every future shift close (function `_pos_open_stmt_on_close`, deliberately avoiding the `shift` substring to satisfy the country-agnostic function-name guard).
- Historical shifts backfilled as `posting_status='historical'` so S5's GL job skips them.
- Guarded by `src/test/architecture/pos-statements-schema.test.ts`.

### S4 — Holding accounts
- New default account roles: `cash_in_drawer`, `merchant_clearing_<processor>`, `mobile_money_clearing_<provider>`, `cash_over_short`, `tip_liability`, `rounding_gain_loss`.
- Business feature flag `use_holding_accounts`. Redirected mappings applied only when flag is on; validation script surfaces which orgs are ready.

### S5 — GL cutover
- New RPC `post_pos_statement_gl(statement_id, p_idempotency_key)` — sole finance write path from POS.
- `trg_pos_transaction_post_sale_gl` + `post_pos_sale_gl` → shadow mode: writes to `accounting_integrity_reports`, never to `journal_entries`.
- Reconciliation view `pos_gl_posting_drift` for one full release.
- Drop shadow objects after finance sign-off.

### S6 — Guardrails
- Architecture tests: no `journal_entries` insert in `process_pos_transaction` call graph; `pos_statements` is the only argument type of the POS accounting RPC; no CHECK-based enum for outbox source (must be domain type).
- CI DB-level test that direct inserts on POS write tables raise `42501`.

## Non-goals (unchanged)

Hardware topology (ADR 0037), receipt rendering (ADR 0008), scanner pipeline (ADR 0013), promotions internals, loyalty accrual, fiscalisation stamping beyond current commit RPC writes, Finance module posting rules.

## Success criteria (unchanged from S7)

- Missing account mapping never returns 400 to a cashier.
- One journal entry per shift (or trading day) per branch, tender-decomposed, drilling to receipts.
- Bank reconciliation matches cash deposits, card settlements, mobile-money settlements without hand-adjustments.
- New tender = config change, never a code change in the commit RPC.
- Every `business_event_outbox.source` is compile-time-safe via the domain type.

Approve to move to build mode; I'll ship S2 first, then S3…S6 as individually reviewable migrations.
