
# POS Financial Posting — Enterprise Architecture Audit & Redesign

## 1. Verified current state (not opinion)

Read from live DB in this turn:

- `pos_payment_session_commit(uuid, jsonb)` calls `process_pos_transaction(...)` inside its own transaction and, on success, flips the session to `committed` and emits `pos.payment.session.committed`.
- `process_pos_transaction` inserts `pos_transactions` header first; the header carries a `DEFERRABLE INITIALLY DEFERRED` constraint trigger `trg_pos_transaction_post_sale_gl` that fires `post_pos_sale_gl(_txn_id)` at COMMIT.
- `post_pos_sale_gl` builds a full journal entry per receipt: one tender-debit line per payment method (via `pos_payment_methods.debit_account_id`), one revenue credit, one tax credit, and — when `cost_price>0` — a COGS/inventory pair. It hard-raises on any missing account mapping.
- `pos_shifts` has `trg_pos_close_variance_gl` (variance-only) — per ADR 0082 D4 the shift close was intentionally demoted; per-sale posting was made authoritative.
- Latest session on register `cba22f78…` at 11:18 UTC is `status='committed'` and Postgres logs show zero ERROR/FATAL in the last 30 minutes. **The specific 400 the user reported has stopped reproducing since the last fix landed** — but that is not the point of this plan. The user is asking whether *the architecture itself* is right.
- ADR 0082 (accepted 2026-07-18) codified "GL posts per sale, in the commit transaction" and lists execution batches T1–T7. Batches T5/T6/T7 are only partially in the tree (per-sale posting is live; shared `_pos_*` helpers and full outbox event set are not).

Everything below is grounded on those reads plus the canonical lifecycle in `docs/audit/pos-transaction-lifecycle-canonical.md`.

## 2. First-principles framing

A POS is an **operational transaction processor** that stands in front of, but is not part of, the general ledger. It owns:

- Basket, pricing, promotions, tax resolution (customer-facing).
- Payment capture (tender authorisation).
- Inventory decrement (physical fact).
- Cash drawer + shift + till reconciliation (operational fact).
- Receipt issuance (legal / fiscal fact).

Accounting is interested in **financial summaries with audit-traceability back to receipts**, not in one journal per receipt. Enterprise retail platforms (SAP POS DM, Oracle Xstore/RMS, D365 Commerce statement posting, LS Central statement, Odoo session close) converge on the same pattern:

```text
Receipts (operational) ──► Session/Shift totals ──► Statement ──► Journal Entry (financial)
                                                    ▲
                                    variance, tender counts, corrections
```

The receipt is the source-of-truth *document*. The statement is the source-of-truth *posting*. Conflating the two makes the GL bear the cardinality of the sales floor.

## 3. Architectural drift identified in our platform

| # | Drift | Evidence |
|---|---|---|
| D1 | Receipt ≡ Journal Entry | `trg_pos_transaction_post_sale_gl` posts a full JE per receipt inside the commit tx. |
| D2 | Session ≡ Shift ≡ Till | `pos_payment_sessions`, `pos_shifts`, `pos_cashier_registers`, `pos_sessions` coexist; no explicit statement layer aggregating them for finance. |
| D3 | Cash drawer ≡ Bank | Tender debit accounts on `pos_payment_methods` post directly to cash/bank asset accounts, skipping an "undeposited funds / cash-in-transit / merchant clearing" holding account. Card settlements and cash deposits then can't reconcile against bank statements. |
| D4 | Operational failure ≡ Accounting failure | Missing account mapping raises inside `post_pos_sale_gl`, which is inside the commit tx → cashier is blocked mid-sale by a finance-config error. ADR 0082 explicitly promised this coupling would be broken; the current implementation re-introduces it. |
| D5 | POS RPC ≡ Domain writer | `process_pos_transaction` writes directly to `stock_movements`, `pos_transaction_items`, `pos_transaction_payments`. The `_pos_insert_line` / `_pos_post_movement` / `_pos_record_payment` helpers named in ADR 0082 D5 aren't the sole write path yet. |
| D6 | Domain events ≡ Table names | Multiple `business_event_outbox` inserters have used table names (`stock_movements`, `pos_transactions`, `pos_transaction_payments`, `db_trigger`) as `source`. The last three days of failures all trace to this — the constraint keeps catching drift because there is no compile-time guarantee. |
| D7 | Client math trusted | `process_pos_transaction` still accepts `p_subtotal`, `p_tax_amount`, `p_discount_amount`, `p_total` from the envelope. ADR 0082 D1 requires server-authoritative math. |

## 4. Target architecture (enterprise-grade)

Nine engines. Each owns exactly one business concept. Ownership is enforced by architecture tests and DB roles, not documentation.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Presentation (Cart UI, Cashier UX)                                   │
└─────────────┬────────────────────────────────────────────────────────┘
              │ intent (product_id, qty, tender_intent, overrides)
┌─────────────▼──────────┐   ┌──────────────────┐   ┌────────────────┐
│ Basket Engine          │──►│ Pricing Engine   │──►│ Promotion Eng. │
└─────────────┬──────────┘   └──────────────────┘   └────────────────┘
              ▼
        Tax Engine ──► Availability & Reservation Engine
              │
              ▼
      Payment Engine (FSM per tender, vendor-agnostic)
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ POS Transaction Engine  (single RPC, atomic, idempotent)             │
│  ├─ writes pos_transactions + items + payments (helper-only)         │
│  ├─ posts stock_movements (helper-only)                              │
│  ├─ emits: sale.committed, payment.received, inventory.decremented   │
│  └─ NO general-ledger writes                                         │
└─────────────┬────────────────────────────────────────────────────────┘
              ▼
   Receipt Engine  ──►  Customer / Loyalty (async, via outbox)
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Cash Drawer + Shift + Till Engines (operational reconciliation)      │
│   counts, variances, blind close, manager approval, deposits         │
└─────────────┬────────────────────────────────────────────────────────┘
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Statement Engine  (NEW — the missing layer)                          │
│   aggregates one shift (or Z-report / trading day) into a            │
│   pos_statements row: gross sales, discounts, tax, tender totals,    │
│   variance, refunds, voids, tips, rounding, deposits.                │
│   Statement is the atom finance consumes.                            │
└─────────────┬────────────────────────────────────────────────────────┘
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Accounting Posting Engine (finance-owned)                            │
│   post_pos_statement_gl(statement_id) → one journal_entry per        │
│   statement, per branch, per day. Retries safely; failure never      │
│   blocks the sales floor.                                            │
└─────────────┬────────────────────────────────────────────────────────┘
              ▼
                        General Ledger  ──►  Reports
```

### Key contracts

- **The POS commit transaction never touches `journal_entries` or `journal_entry_lines`.** That coupling is the root of D1 and D4.
- **`pos_statements` is the only object the Accounting Posting Engine consumes.** Statement = shift close (retail default) or trading-day close (24/7 stores). Configurable per-business.
- **Cash flows through holding accounts, not straight to bank.** Tender debits go to: `cash_in_drawer` (cash), `merchant_clearing:<processor>` (card), `mobile_money_clearing:<provider>` (mpesa etc.). Deposits + settlements move balances to bank via their own posting RPCs. This is what makes bank reconciliation possible.
- **All outbox `source` values are constrained by a Postgres domain type (`event_source_domain`) rather than a free-text CHECK.** Any new emitter is a compile error, not a runtime `400`.
- **Every write to `pos_transaction_items`, `pos_transaction_payments`, `stock_movements` from POS goes through the `_pos_*` SECURITY DEFINER helpers.** Enforced by an architecture test that greps for direct `INSERT INTO` in the `public` schema.

### Refunds, voids, reversals, over/short

- **Void** (same-shift, pre-settlement): reverses the receipt inside the shift totals; nets to zero in the statement; no separate accounting event.
- **Refund** (post-settlement): posted as a *new* receipt of type `return`, aggregated into the next statement.
- **Cash over/short**: variance line on the statement, posted to `cash_over_short` expense/income account by the Accounting Posting Engine — never inside the commit tx.
- **Card settlement**: card tenders debit `merchant_clearing`; when the processor settlement file lands, a separate reconciliation moves cleared amounts to bank and residuals to fees. Handled by the existing `pos_card_settlements` machinery, but now cleanly separated from receipt posting.
- **Mixed tender / partial / deferred**: naturally supported because tenders and receipts are separate rows; the statement sums them.

## 5. Migration path (non-breaking, sequenced)

None of this ships as a big-bang. Each step is independently deployable and reversible.

- **S0 — Freeze the drift surface (this batch).** Introduce `event_source_domain` type; migrate `business_event_outbox.source` to it; rewrite every remaining emitter to use a valid domain tag. This kills the class of failure the user has been hitting.
- **S1 — Extract `_pos_*` helpers** and rewrite `process_pos_transaction`, `process_pos_return`, `process_pos_void`, `recall_pos_held_transaction`, `finalize_table_order` to compose them. Add architecture test forbidding direct writes.
- **S2 — Move money math server-side.** Deprecate client-supplied `p_subtotal/p_tax/p_discount/p_total`; server re-derives; RPC returns `total_matches_server`. UI keeps advisory display math for latency.
- **S3 — Introduce `pos_statements`.** Populated on shift close (or trading-day close). Backfill historical statements from `pos_shifts` + `pos_transactions` so reporting continuity is preserved.
- **S4 — Introduce holding accounts.** New default account roles: `cash_in_drawer`, `merchant_clearing`, `mobile_money_clearing`, `cash_over_short`, `tip_liability`, `rounding_gain_loss`. `pos_payment_methods.debit_account_id` is redirected to the appropriate holding account. Existing bank accounts stay put — deposits/settlements are what move money out of holding.
- **S5 — Cutover accounting posting.** New `post_pos_statement_gl(statement_id)` becomes the sole finance write path from POS. `post_pos_sale_gl` and its constraint trigger are demoted to a *shadow* mode (writes to `accounting_integrity_reports`, never to `journal_entries`) for one release, then dropped. Existing per-sale journals remain in place historically; new sales post via statement.
- **S6 — Guardrails.** Architecture tests: (a) `journal_entries` inserts are forbidden inside `process_pos_transaction`'s call graph; (b) `pos_statements` is the only argument type accepted by the POS accounting RPC; (c) no CHECK-based enum for outbox source.

Each step ships as one migration + one PR + one architecture test. Reversal is: drop the new object, restore the previous default account mapping.

## 6. What this does *not* touch

Hardware execution topology (ADR 0037), receipt rendering (ADR 0008), scanner pipeline (ADR 0013), promotions internals, loyalty accrual mechanics, fiscalisation stamping beyond what the commit RPC already writes, and the Finance module's own posting rules. Those are separate audits already recorded in ADRs 0037, 0057, 0082.

## 7. Success criteria

- A missing account mapping never returns a `400` to a cashier. Worst case: sale commits, statement fails to post, finance sees a queued `pos_statements.posting_status='error'` with a retry action.
- A single `journal_entry` per shift per branch (or per trading day), tender-decomposed, with `source_reference` = the `pos_statements.id` and drill-down to every receipt.
- Bank reconciliation matches cash deposits, card settlements, and mobile-money settlements without hand-adjustments.
- Adding a new tender (e.g. crypto, BNPL) is a config change (new `pos_payment_methods` row + holding account), never a code change in the commit RPC.
- Every `business_event_outbox` insertion is compile-time-safe on `source`.

## Technical appendix (implementation details)

- New Postgres domain: `CREATE DOMAIN public.event_source_domain AS text CHECK (VALUE IN ('pos','finance','manual','system','trigger','procurement','purchasing','hr','crm','sales','inventory','warehouse','payroll','accounting','cash_management','statement'));`
- New tables: `pos_statements (id, org_id, business_id, branch_id, register_id, shift_id, opened_at, closed_at, gross_sales, discounts, tax, tip_total, refund_total, void_total, tender_totals jsonb, variance_amount, posting_status, journal_entry_id, …)` with GRANTs + RLS; `pos_statement_lines` optional for tender breakdown.
- New RPCs: `open_pos_statement(shift_id)`, `close_pos_statement(shift_id, counts jsonb)`, `post_pos_statement_gl(statement_id)`. All `SECURITY DEFINER`, all `p_idempotency_key text NOT NULL`.
- New helpers (SECURITY DEFINER): `_pos_insert_line`, `_pos_post_movement`, `_pos_record_payment`, `_pos_record_tender_summary`.
- New default account roles registered in `default_account_settings`: `cash_in_drawer`, `merchant_clearing_<processor>`, `mobile_money_clearing_<provider>`, `cash_over_short`, `tip_liability`, `rounding_gain_loss`.
- Deprecations (staged, not immediate): `trg_pos_transaction_post_sale_gl` → shadow-mode → drop; `post_pos_sale_gl` → shadow-mode → drop.
- Outbox: standardise on the domain type; add `sale.committed` + `inventory.decremented` topics; consumers key on `pos_transaction_id`.
- Architecture tests: `pos-no-journal-writes-in-commit.test`, `pos-outbox-source-is-domain.test`, `pos-writes-through-helpers-only.test`, `pos-statement-is-only-accounting-atom.test`.
- All new tables carry `GRANT SELECT,INSERT,UPDATE,DELETE … TO authenticated; GRANT ALL … TO service_role;` and RLS scoped by `assert_pos_caller_branch_access` / `has_role`.

Approve to move to build mode; I'll ship it as S0 first (highest-leverage, kills the recurring 400 class), then S1…S6 as individually reviewable migrations.
