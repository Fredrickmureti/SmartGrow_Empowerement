# POS Financial Posting — Continuation Plan

## Phase 1 — Verification of prior work (COMPLETE)

Independently verified `.lovable/plan.md` claims against the live DB and codebase. Every "✅ COMPLETE" claim holds up:

| Claim | Evidence | Verdict |
|---|---|---|
| S0 `event_source_domain` typed outbox | domain + column present | ✅ |
| S1 helper-only POS writes | `trg_pos_items_helper_only`, `trg_pos_payments_helper_only` present; `_pos_insert_line`, `_pos_record_payment`, `_pos_apply_lot_consumption`, `_pos_write_receipt_snapshot`, `attach_c2b_to_pos_transaction` in `pg_proc` | ✅ |
| S2 server-authoritative totals | `no-client-pos-money-math.test.ts` + `pos-commit-response-shape.test.ts` present; `paymentSessionClient.ts` exposes `server_totals` | ✅ |
| S3 `pos_statements` + tender lines | both tables exist; `open_pos_statement`, `close_pos_statement`, `_pos_open_stmt_on_close` in `pg_proc`; `trg_pos_open_stmt_on_close` on `pos_shifts`; `pos-statements-schema.test.ts` present | ✅ |
| S4 holding accounts | `pos_tender_holding_account_map` exists; `resolve_pos_tender_gl_account` present; `businesses.use_holding_accounts` default `false`; `pos-holding-accounts-schema.test.ts` present | ✅ |
| S5 pending | `post_pos_statement_gl` NOT in `pg_proc`; `trg_pos_transaction_post_sale_gl` still live | Correctly pending |

Resume point is genuinely **S5 (GL cutover)** — no rework required, no drift introduced.

## Phase 2 — Plan additions (justified by re-audit)

The prior plan's S5.a (shadow-mode drift view) is retained. One expansion, based on codebase evidence:

- **S5.b — Outbox-driven, not trigger-driven, statement posting.** `post_pos_statement_gl` must be invoked by a `business_event_outbox` row (`event_type='pos.statement.closed'`, scope=`server`) emitted from `close_pos_statement`, drained by the existing `outbox-dispatcher` edge function. Rationale: keeps the finance write off the cashier's request path, gives retries + DLQ for free, matches the pattern established for every other cross-domain posting on this platform (`docs/adr/0014`, `BusinessSaga`). A synchronous trigger would repeat the S1 mistake at a new layer.
- **S6.b — Domain-event contract test.** Assert `pos.statement.closed` is the only event that can drive finance writes from POS, and that `pos.transaction.committed` never enters the finance handler chain.

## Phase 3 — Execution (S5 → S6)

### S5 — GL cutover (statement-centric posting)

Migration 1 · schema + posting RPC
- New enum value `pos.statement.closed` (via existing `event_source_domain` / topic table).
- `post_pos_statement_gl(p_statement_id uuid, p_idempotency_key text)` — SECURITY DEFINER, STABLE-safe wrapper around one `journal_entries` insert per statement:
  - Debits: per-tender sums via `resolve_pos_tender_gl_account(business_id, branch_id, tender_kind, provider_key, payment_method_id)`.
  - Credits: sales revenue (per product category default account), output tax (per tax_rate), rounding, discounts contra, tips liability, gift-card liability movement, refund contra.
  - Balancing check enforced in-RPC; refuses to write unbalanced JE.
  - Idempotency: unique `(statement_id, idempotency_key)` on a new `pos_statement_gl_apply_log` table.
  - On success: `UPDATE pos_statements SET posting_status='posted', journal_entry_id=..., posted_at=now()`.
- New table `pos_statement_gl_apply_log` (statement_id, idempotency_key unique, je_id, posted_at) with GRANTs + RLS scoped by branch.
- Trigger `trg_pos_stmt_emit_close_event` on `pos_statements` (AFTER UPDATE, status pending→posted-pending) inserts a `business_event_outbox` row with `handler_scope='server'`.

Migration 2 · demote per-sale posting to shadow
- Rewrite `post_pos_sale_gl` body to INSERT into `accounting_integrity_reports` (kind=`pos_shadow_posting`) instead of `journal_entries`. Trigger stays attached (audit continuity), no finance rows produced.
- Backfilled `historical` statements remain skipped by `post_pos_statement_gl` (early return).

Migration 3 · reconciliation view
- `v_pos_gl_posting_drift(statement_id, tender_kind, shadow_total, statement_total, delta, drift_bps)` — joins shadow rows to statement totals for one release cycle.

Code
- New server function `src/lib/pos/postStatementGl.functions.ts` (createServerFn + requireSupabaseAuth) — thin wrapper that RPC-calls `post_pos_statement_gl` and returns `{journal_entry_id, drift_bps}`. Called by the outbox dispatcher, not by the UI.
- Outbox handler registration for `pos.statement.closed` under `src/services/events/handlers/postPosStatementGl.ts`. Server-scope handler.
- New Finance surface `src/routes/_authenticated/finance.pos.drift.tsx` reading `v_pos_gl_posting_drift` — read-only, tenant-scoped.
- Update `src/apps/pos/routes.tsx` Shifts detail to show `Statement → Journal Entry` link when posted.

Architecture tests (added under `src/test/architecture/`)
- `pos-statement-gl-single-writer.test.ts` — grep asserts no code path other than `post_pos_statement_gl` inserts JE lines tagged `source_module='pos'`.
- `pos-sale-gl-is-shadow.test.ts` — parses the `post_pos_sale_gl` function body from `pg_proc` (via `information_schema`/`pg_get_functiondef` fixture) and fails on any `INSERT INTO journal_entries`.
- `pos-statement-close-emits-outbox.test.ts` — end-to-end: closing a synthetic statement produces exactly one `business_event_outbox` row.

### S6 — Guardrails & cleanup

- `pos-outbox-only-finance-write.test.ts` — negative test: `process_pos_transaction` call graph contains zero `journal_entries` writes.
- DB-level test: direct `INSERT INTO pos_transaction_items` as a non-service role must return `42501`; run via a Playwright-driven auth harness + service-role bypass reference, not a mock.
- ADR `docs/adr/00XX-pos-statement-centric-gl-posting.md` capturing: statement=accounting unit, receipt=operational unit, holding accounts as cash-flow bridge, outbox-driven posting, per-processor sub-ledger via `pos_tender_holding_account_map`.
- After one full release with zero drift in `v_pos_gl_posting_drift`, drop `trg_pos_transaction_post_sale_gl`, `post_pos_sale_gl`, and the `accounting_integrity_reports` shadow rows via migration `drop_pos_per_sale_gl.sql`. Not part of this loop — flagged for the follow-up loop.

## Sequencing & reversibility

Each of the three S5 migrations is independently reversible. Shadow mode means finance sees zero behavior change until the org-level `use_holding_accounts` flag is on AND at least one statement has posted cleanly. Historical rows are marked `historical` and never re-posted.

## Non-goals (unchanged)

Hardware topology, receipt rendering, scanner pipeline, promotions, loyalty accrual, fiscalisation. Finance module posting rules are consumers of `pos_statements`, not modified here.

## Success criteria

- One balanced `journal_entries` row per closed `pos_statements` row, tender-decomposed, drilling to receipts.
- Zero JE inserts from `process_pos_transaction` / `post_pos_sale_gl`.
- `v_pos_gl_posting_drift` returns rows with `delta=0` across a full release before shadow objects are dropped.
- Missing tender mapping falls back to legacy `pos_payment_methods.debit_account_id`; cashier never sees a 400.
- Adding a new tender/provider = INSERT into `pos_tender_holding_account_map`, zero code change.

## S5 — GL cutover ✅ COMPLETE (shadow mode live)

Shipped in one atomic migration (see `supabase/migrations/*post_pos_statement_gl*.sql`):

- `pos_gl_shadow_postings` — captures what the legacy per-sale poster would have posted; unique on `transaction_id`, RLS by `user_can_access_branch(auth.uid(), branch_id)`.
- `pos_statement_gl_apply_log` — statement-post idempotency (`UNIQUE(statement_id, idempotency_key)`).
- Trigger `trg_pos_stmt_enqueue_gl_post` on `pos_statements` — enqueues `pos.statement.posting.requested` on close (skips `historical_backfill`).
- Outbox topic registered in `business_event_topics` with `handler_scope='server'`, `max_attempts=10`.
- `post_pos_statement_gl(statement_id, idempotency_key)` — SECURITY DEFINER, `search_path=public`. One balanced JE per statement: per-tender debits via `resolve_pos_tender_gl_account` (holding accounts when flag on, legacy `pos_payment_methods.debit_account_id` fallback when off); revenue net-of-returns-and-tax credit; aggregate output-tax credit; optional tips-liability credit. Refuses to write unbalanced JE. Marks statement `posted` + stamps `journal_entry_id`.
- `post_pos_sale_gl` demoted: body now only inserts into `pos_gl_shadow_postings`. Trigger `trg_pos_transaction_post_sale_gl` stays for shadow audit continuity.
- `v_pos_gl_posting_drift` view — per-statement diff of shadow gross/tax/tx-count vs statement totals.
- Outbox dispatcher (`supabase/functions/outbox-dispatcher/index.ts`) drains `pos.statement.posting.requested` by calling `post_pos_statement_gl` with `outbox:{event_id}` as idempotency key.
- Architecture guard: `src/test/architecture/pos-statement-gl-cutover.test.ts` — 10 tests pin every S5 surface (SECURITY DEFINER, balance check, shadow-only per-sale poster, outbox enqueue, topic registration, drift view, dispatcher wiring).

Backward compatibility: with `businesses.use_holding_accounts=false` (default), the resolver returns the legacy `pos_payment_methods.debit_account_id`, so every existing tender mapping keeps posting to the same account it did before — the change is the *aggregation granularity* (per-statement, not per-receipt), not the account map.

## S6 — Guardrails & cleanup (next loop)

- Additional negative test: exec-time DB proof that direct `INSERT INTO pos_transaction_items` as a non-service role returns `42501` (auth-harness driven, not mocked).
- Domain-event contract test: `pos.statement.posting.requested` is the only POS event that reaches the finance handler chain.
- ADR `docs/adr/00XX-pos-statement-centric-gl-posting.md` — statement=accounting unit, receipt=operational unit, holding accounts as cash-flow bridge, outbox-driven posting, per-processor sub-ledger via `pos_tender_holding_account_map`.
- After one release with `v_pos_gl_posting_drift.delta_gross = 0` everywhere: drop `trg_pos_transaction_post_sale_gl`, `post_pos_sale_gl`, and `pos_gl_shadow_postings` in a follow-up migration.

