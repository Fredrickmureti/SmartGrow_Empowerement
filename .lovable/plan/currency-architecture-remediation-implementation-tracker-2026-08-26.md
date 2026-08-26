# Currency Architecture Remediation — Implementation Tracker

Baseline: `docs/audits/currency-architecture-audit.md` (audit COMPLETE, 2026-08-26). This file is the living execution log. No re-audit. Evidence tags FACT / STD / INFER / UNKNOWN are inherited unchanged.

## Handoff acknowledgement

**1. What the audit established.** The currency model is fundamentally sound and enforced in the database, not in React. One rate-resolution authority, hard refusal on a missing rate, stamped-and-immutable posted rates, base-currency-only GL, realized FX from stamped rates, auto-reversing unrealized revaluation, intact tenant/business isolation. The KES→INR HTTP 400 was the system working correctly. Defects are peripheral and corrective, not a rebuild.

**2. Core architecture.** `_pick_exchange_rate_row` → `resolve_exchange_rate` → `require_exchange_rate` → `fx_stamp_document`. Rate precedence: latest `effective_date <= on_date`, business-scope over org-scope, override > manual > provider, then `published_at`. Business is the accounting entity; branch owns no currency. Client `rateBook.ts` is a display-only mirror that returns `null` rather than guessing.

**3. Confirmed defects remaining.** D1 silent 1:1 in four live reporting functions (two of them reconciliations) · D2 unstamped `bank_transactions.exchange_rate` · D3 unstamped `bill_payments.currency_rate`, no currency column · D4 non-provider rate rows editable/deletable, no audit · D5 backdated overrides rewrite historical resolution, no closed-period guard on rate writes · D6 fixed assets have no currency/acquisition-rate evidence · D7 budgets carry a currency label with no conversion model · D8 rate book only 2026-08-12 → 2026-08-26 · D9 posted-immutability guard missing on estimates, sales orders, customer refunds, POs · D10 `rfq_quotations` has zero triggers · D11 invoice/bill re-stamp asymmetry · D12 two formatting policies, zero-decimal currencies wrong in reports/PDF · D13 dead duplicate `enforce_business_currency_immutable` · D14 vocabulary drift · D15 revaluation concurrency race. Security: S1 `exchange_rates_all` has no finance-role predicate; S2 org-scoped rates invisible to the client (latent).

**4. UNKNOWNs deliberately left open.** Inventory cost layers / payroll / POS currency columns; whether any of ~205 `toFixed(2)` sites render currency; fixed-asset acquisition RPC internals; whether `payments` / `payment_allocations` permit cross-currency allocation. These are not defects until inspected.

**5. Remediation phases.** Nine dependency-ordered phases, unchanged, listed below.

**6. What I would inspect next.** Phase-scoped only — for Phase 1: the four `pg_proc` bodies, `finance_ar_net_position_by_currency` as the reference pattern, and every TypeScript/report consumer of those four functions' result shapes.

## Invariants (apply to every phase)

- No report or posting may value a foreign document at 1:1 unless the currencies are identical.
- Every rate reaching accounting is resolved server-side by the one engine.
- Posted amounts, stamped rates, and GL balances are never silently rewritten.
- Base currency stays immutable once a journal entry exists; no books-conversion feature; no branch functional currency.
- Rate evidence is superseded, never destroyed.
- Formatting never participates in arithmetic.

## Phase log

Status values: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `DONE`.

### Phase 1 — Stop silent 1:1 in reporting (D1) — **NOT STARTED**
Replace `COALESCE(NULLIF(exchange_rate, 0), 1)` with NULL propagation in `finance_sales_analysis`, `finance_purchase_analysis`, `finance_sales_revenue_reconciliation`, `finance_purchase_expense_reconciliation`; surface an explicit unconvertible-document count mirroring `finance_ar_net_position_by_currency`. Update consumers to render an absence, not a zero. Depends on: nothing.
Validation: before/after totals identical where every document has a rate; absence reported where one does not.

### Phase 2 — Rate-book integrity and privilege (D4, D5, S1) — **NOT STARTED**
Immutability extended to all sources (no UPDATE/DELETE); corrections become new dated rows; `exchange_rate_audit` trail (actor, reason, prior value); `exchange_rates_all` narrowed to a finance-manager predicate with `exchange_rates_select` left broad; closed-period rejection on rate writes; client delete path removed. Depends on: Phase 1.
Must not change: precedence rule, provider publishing, any stamped rate.

### Phase 3 — Close the stamping gaps (D2, D3, D9, D10, D11) — **NOT STARTED**
Stamping triggers through `fx_stamp_document` for `bank_transactions`, `bill_payments` (with an explicit `currency` column), `rfq_quotations`; `_fx_document_is_posted` guard added to estimates, sales orders, customer refunds, POs; invoice re-stamp aligned with the bill rule (re-stamp on document-date change while unposted). Backfill reports mismatches, never rewrites. Depends on: Phase 2.

### Phase 4 — Rate coverage and history (D8) — **NOT STARTED**
Backfill provider history to each business's earliest transaction date; documented retention/publishing schedule; coverage indicator; explicit documented policy for dates before coverage (recommended: dated override with a mandatory reason). Depends on: Phase 2.
Invariant: never invent a rate.

### Phase 5 — Base-currency lifecycle (§5, D13, U1, U2) — **NOT STARTED**
`business_currency_readiness(business_id)` returning lifecycle state plus every blocker; audited change RPC that re-stamps drafts in the same transaction where the change is still permitted; dead `enforce_business_currency_immutable` removed. Depends on: Phase 3.
Must not change: the journal-entry hard lock.

### Phase 6 — Non-monetary assets and budgets (D6, D7) — **NOT STARTED**
`fixed_assets` gains currency + acquisition rate (+ derived base cost), stamped at acquisition and immutable, for IAS 21 historical-rate carrying. Budget currency policy decided after reading the budget architecture — recommended base-currency-only. Depends on: Phase 3. Requires resolving the fixed-asset acquisition RPC UNKNOWN first.

### Phase 7 — Presentation convergence (D12, D14) — **NOT STARTED**
One catalogue-driven formatter (`decimal_places`, `symbol`); hardcoded 2dp and symbol map removed from `src/design-system/reports/format.ts` and `currencyPresentation.ts`; optional `en-IN` grouping, presentation only; vocabulary documented, no broad rename. Depends on: nothing; sequenced late.

### Phase 8 — Currency Settings UX (U3–U9) — **NOT STARTED**
Three distinct surfaces: base currency as a lifecycle status card driven by Phase 5 readiness; operating currencies as an enabled-list plus searchable add-dialog; rate book filtered to enabled pairs with currently-effective rate and provenance from `describe_exchange_rate`, history and audit behind a per-pair drill-down. Depends on: Phases 2, 4, 5.

### Phase 9 — Regression protection (D15, S2, §13) — **NOT STARTED**
Architecture tests: no `COALESCE(<rate>, 1)` in any `pg_proc` body or view; every rate-bearing table has a stamping trigger; every currency table's write policy carries a role predicate. Partial unique index on `(business_id, fiscal_period_id) WHERE status = 'posted'` plus advisory lock in `revalue_fx_balances`. S2 resolved. Disabling a currency with open balances blocked. Depends on: all prior phases.

## Per-phase working protocol

1. Read only the audit section for the phase.
2. Enumerate the exact functions, tables, triggers, RPCs, policies, components, tests involved.
3. Inspect only those paths.
4. Before editing, state: current behaviour · why defective · what the audit requires · what changes · what explicitly does not · invariants held.
5. Smallest coherent change; no unrelated cleanup.
6. Targeted validation.
7. Update this file: status, files changed, database objects changed, behaviour changed, behaviour intentionally unchanged, validation performed, remaining risks, completion verdict.

## Change log

_(append one entry per completed phase)_
