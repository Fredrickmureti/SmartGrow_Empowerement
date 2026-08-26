# Currency Architecture Remediation — Authoritative Project Status

Baseline: `docs/audits/currency-architecture-audit.md` (audit COMPLETE, 2026-08-26).
This file is the single source of truth for what is done, what is pending, and what
comes next. No re-audit. Full Phase 1–2 detail is also mirrored in
`.lovable/plan/currency-architecture-remediation-implementation-tracker-2026-08-26.md`.

Last updated: 2026-08-26.

## Invariants (apply to every phase)

- No report or posting may value a foreign document at 1:1 unless the currencies are identical.
- Every rate reaching accounting is resolved server-side by the one engine
  (`_pick_exchange_rate_row` → `resolve_exchange_rate` → `require_exchange_rate` → `fx_stamp_document`).
- Posted amounts, stamped rates and GL balances are never silently rewritten.
- Base currency stays immutable once a journal entry exists; no books conversion; no branch functional currency.
- Rate evidence is superseded, never destroyed.
- Formatting never participates in arithmetic.

## Status at a glance

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Stop silent 1:1 in reporting (D1) | **DONE — verified** |
| 2 | Rate-book integrity and privilege (D4, D5, S1) | **DONE — verified** |
| 3 | Close the stamping gaps (D2, D3, D9, D10, D11) | **DONE — verified at runtime** |
| 4 | Rate coverage and history (D8) | **NEXT** |
| 5 | Base-currency lifecycle (D13, U1, U2) | Pending |
| 6 | Non-monetary assets and budgets (D6, D7) | Pending |
| 7 | Presentation convergence (D12, D14) | Pending |
| 8 | Currency Settings UX (U3–U9) | Pending |
| 9 | Regression protection (D15, S2) | Pending |

Currently active phase: **Phase 4** (Phase 3 completed and runtime-verified 2026-08-26).

---

## Completed work

### Phase 1 — Stop silent 1:1 in reporting (D1) — DONE 2026-08-26

**Was.** `finance_sales_analysis`, `finance_purchase_analysis`,
`finance_sales_revenue_reconciliation`, `finance_purchase_expense_reconciliation`
valued documents at `COALESCE(NULLIF(rate, 0), 1)`; a rate-less foreign document was
reported at face value and reconciliations could tie out on that invented figure.

**Now.** New `public.fx_report_document_rate(document_currency, stamped_rate, base_currency)`
(`IMMUTABLE`, fixed search path) returns the stamped rate, `1` only for a genuine
base-currency document, otherwise `NULL`. All four functions use it, exclude
unconvertible rows from every measure, count them explicitly
(`totals.unconvertible_document_count` + `unconvertible` breakdown; per-kind counts on
the reconciliations), and `in_balance` is false while any count is non-zero.

**Client.** `src/services/finance/salesAnalysis.ts`, `src/services/finance/purchaseAnalysis.ts`,
`src/hooks/useSalesAnalysis.ts`, `src/hooks/usePurchaseAnalysis.ts`,
`src/pages/reports/SalesReports.tsx`, `src/pages/reports/PurchaseReports.tsx` —
the reports now state which documents could not be valued in the base currency and why.

**Unchanged by design.** Posted amounts, stamped rates, GL balances, the GL side of both
reconciliations, rate precedence, every stamping path.

**Verified.** Helper and the new SQL shapes executed against live data (Joshua Holdings,
Dekto Logistics): zero unconvertible documents, totals unchanged (gross 17,400.00 for
Joshua Holdings). Typecheck clean.

### Phase 2 — Rate-book integrity and privilege (D4, D5, S1) — DONE 2026-08-26

**Was.** `exchange_rates_all` granted every business member full `ALL` rights with no
finance-role predicate (S1); only provider rows were immutable, so manual/override rows
could be edited or deleted, destroying the evidence behind posted documents (D4); rates
could be dated into a closed period with no guard and no audit of who changed what (D5);
the client had a direct table insert and a delete button.

**Now.**
- `tg_exchange_rates_immutable` blocks UPDATE and DELETE for **every** source. A correction
  is a new dated row, which the unchanged precedence rule already outranks.
- `tg_exchange_rates_write_guard` (BEFORE INSERT): rate must be > 0; an interactive caller
  must have business access **and** `is_finance_manager`; a non-provider rate dated inside a
  non-open `fiscal_periods` row is refused. Provider publishing and platform admins are
  deliberately exempt from the finance-role and closed-period rules — provider rows are
  reference data and a tenant override still outranks them.
- `tg_exchange_rates_audit` (AFTER INSERT) writes `public.exchange_rate_audit`: actor,
  stated reason, new rate, and the prior rate/source/date it supersedes for that pair,
  resolved with the same precedence order the engine uses.
- RLS: `exchange_rates_all` dropped. `exchange_rates_select` stays broad (read the rate book);
  `exchange_rates_insert` requires business access **and** a finance role. No UPDATE/DELETE
  policy exists. `UPDATE`/`DELETE` revoked from `authenticated`; `anon` has nothing.
- `exchange_rate_audit`: RLS on, read-only to finance managers of the company, all other
  privileges revoked from `anon`/`authenticated`; written only by the definer trigger.
- `set_exchange_rate_override` now enforces the finance role, requires a non-empty reason,
  and passes it to the audit trigger via a transaction-local setting.
- Client: `CurrencyContext.addExchangeRate` routes through `set_exchange_rate_override`
  (reason now a required argument) instead of a raw insert; the delete button and handler
  are gone from `src/components/settings/CurrencySettings.tsx`, with the append-only rule
  stated in the card description.

**Unchanged by design.** Rate precedence, `publish_platform_rates` (insert-only,
`ON CONFLICT DO NOTHING` — compatible with absolute immutability), every stamped rate,
`resolve_exchange_rate`/`require_exchange_rate`/`fx_stamp_document`.

**Verified.** Catalog inspection confirms: policies are exactly `exchange_rates_select`
(SELECT, authenticated) and `exchange_rates_insert` (INSERT, authenticated); triggers
`tg_exchange_rates_immutable`, `tg_exchange_rates_write_guard`, `tg_exchange_rates_audit`,
plus the pre-existing normalise and org-lock triggers; `authenticated` holds SELECT+INSERT
only on `exchange_rates` and SELECT only on `exchange_rate_audit`; `anon` holds nothing on
either. No edge function or database routine updates or deletes `exchange_rates`.
Security linter total unchanged at the pre-existing 3684 baseline — the phase added no new
findings. Typecheck clean.

---

## Pending work

### Phase 3 — Close the stamping gaps (D2, D3, D9, D10, D11) — DONE 2026-08-26

**Verification of Phases 1–2 before starting (catalog, not trust in the log).**
`fx_report_document_rate` exists and none of the four reporting functions still contains a
`COALESCE(rate, 1)`; `exchange_rates` carries exactly `exchange_rates_select` (SELECT) and
`exchange_rates_insert` (INSERT) with no UPDATE/DELETE policy and all three Phase 2 triggers
attached; `exchange_rate_audit` exposes SELECT only. Both phases confirmed genuinely complete.

**Was.** `bill_payments.currency_rate` defaulted to 1 with no currency column and no server
stamping; `bank_transactions.exchange_rate` defaulted to 1 with no stamping; `rfq_quotations`
had `currency`/`exchange_rate` and no triggers at all; estimates, sales orders, purchase orders
and customer refunds could have their stamped rate changed after posting; invoices did not
re-stamp on a document-date change while bills did.

**Now.**
- `bill_payments` has an explicit `currency` (backfilled from the paying bank account, else the
  business base currency; `NOT NULL`). `trg_bill_payments_stamp_currency` stamps currency and
  `currency_rate` through `fx_stamp_document` on `payment_date`, refuses a foreign payment with
  no rate on file, ignores any client-supplied rate, and refuses a currency/rate change once the
  payment is posted (`journal_entries`) or allocated (`bill_payment_allocations`).
- `bank_transactions.exchange_rate` lost its `DEFAULT 1`.
  `trg_bank_transactions_stamp_currency` stamps `original_currency` (transaction, else bank
  account, else base) and the rate on `transaction_date`, and freezes both once the transaction
  is reconciled or carries a `journal_entry_id`.
- `trg_rfq_quotations_stamp_currency` stamps quotations (org/business resolved through `rfqs`,
  date = `submitted_at`) and freezes them once superseded or withdrawn.
- D9: `_fx_document_is_posted_any(text[], uuid)` added; estimates, sales orders, purchase orders
  and customer refunds now refuse a currency/rate change on a posted document and re-stamp on a
  document-date change while unposted.
- D11: invoices now re-stamp on an `issue_date` change while unposted — symmetric with bills.
- `fx_stamped_rate_review(business_id)` (finance managers only, `authenticated`-execute) lists
  payments and bank transactions whose stored rate disagrees with the rate book. Read-only.

**Unchanged by design.** The one resolution engine, rate precedence, every already-stamped rate,
posted GL amounts, allocation and realized-FX arithmetic, closed periods, `publish_platform_rates`.
No historical row was re-rated; the backfill only labelled the payment currency.

**Verified at runtime** (self-cancelling transactions, all test rows discarded):
base-currency payment accepted and stamped 1; foreign payment with no rate refused; a
client-supplied rate of 999 overwritten with the engine's 1; a payment saved without a currency
stamped KES/1; bank transaction stamped from its account (KES/1); foreign bank transaction
refused with no rate; rate change on a reconciled transaction refused; a EUR bank transaction
stamped 140.76086957, exactly `resolve_exchange_rate`. All nine stamping triggers confirmed
attached. Typecheck clean. Security linter 3685 vs the 3684 baseline — the single delta is
`fx_stamped_rate_review` being callable by signed-in users, which is intended: it enforces
`is_finance_manager` internally. The four pre-existing document stamp functions were kept
`SECURITY INVOKER` and the new internal trigger functions have `EXECUTE` revoked from
`anon`/`authenticated`.


### Phase 4 — Rate coverage and history (D8)
Backfill provider history to each business's earliest transaction date; documented
retention/publishing schedule; coverage indicator; documented policy for dates before
coverage (recommended: dated override with a mandatory reason — now enforced by Phase 2).
Never invent a rate.

### Phase 5 — Base-currency lifecycle (D13, U1, U2)
`business_currency_readiness(business_id)` returning lifecycle state and every blocker;
audited change RPC that re-stamps drafts in the same transaction while the change is still
permitted; remove the dead duplicate `enforce_business_currency_immutable`. The
journal-entry hard lock does not change.

### Phase 6 — Non-monetary assets and budgets (D6, D7)
`fixed_assets` gains currency + acquisition rate (+ derived base cost), stamped at
acquisition and immutable (IAS 21 historical rate). Budget currency policy decided after
reading the budget architecture — recommended base-currency-only. Resolve the fixed-asset
acquisition RPC UNKNOWN first.

### Phase 7 — Presentation convergence (D12, D14)
One catalogue-driven formatter (`decimal_places`, `symbol`); remove the hardcoded 2dp and
symbol map from `src/design-system/reports/format.ts` and `currencyPresentation.ts`;
optional `en-IN` grouping, presentation only; document vocabulary, no broad rename.

### Phase 8 — Currency Settings UX (U3–U9)
Three surfaces: base currency as a lifecycle status card driven by Phase 5 readiness;
operating currencies as an enabled list plus a searchable add dialog; rate book filtered to
enabled pairs showing the currently effective rate and provenance from
`describe_exchange_rate`, with history **and the Phase 2 `exchange_rate_audit` trail**
behind a per-pair drill-down. (The audit trail is written and secured today but has no UI
yet — that surfacing belongs here.)

### Phase 9 — Regression protection (D15, S2)
Architecture tests: no `COALESCE(<rate>, 1)` in any `pg_proc` body or view; every
rate-bearing table has a stamping trigger; every currency table's write policy carries a
role predicate. Partial unique index on `(business_id, fiscal_period_id) WHERE status='posted'`
plus an advisory lock in `revalue_fx_balances`. Resolve S2. Block disabling a currency with
open balances.

---

## Known residual risks

- The SQL runner cannot invoke the four Phase 1 reporting RPCs (`42501` by design), so their
  end-to-end execution is proven through their constituent SQL and typecheck, not through an
  authenticated session. Worth one authenticated smoke test of Sales and Purchase Reports.
- Phase 2 write paths (immutability refusal, closed-period refusal, non-finance refusal) were
  verified structurally from the catalog, not by executing a rejected DML as each role.
- `exchange_rate_audit` has no UI consumer until Phase 8.
- `fx_stamped_rate_review` has no UI consumer yet; surface it with the Phase 8 rate-book drill-down.
- Legacy `rfq_quotations` rows predating Phase 3 may still hold a null `exchange_rate`; they are
  left untouched (no history rewrite) and re-stamp on their next edit.
- The Phase 3 posted-document guards match `journal_entries.source_type` values
  `estimate(s)`, `sales_order(s)`, `purchase_order(s)`, `customer_refund(s)`, `bill_payment(s)`,
  `payment`. If a posting path introduces another spelling, extend the arrays.

## Instructions for the next agent

1. **Verify before you build.** Confirm Phases 1 and 2 are genuinely complete and
   enterprise-grade before writing anything new:
   - No `COALESCE(<rate>, 1)` remains in the four reporting functions; `fx_report_document_rate`
     is `IMMUTABLE` with a fixed search path.
   - `exchange_rates` has no UPDATE/DELETE policy and `authenticated` holds no UPDATE/DELETE
     privilege; the three triggers are attached; `exchange_rate_audit` is read-only to finance
     managers and closed to `anon`.
   - Ideally run an authenticated smoke test: open Sales Reports and Purchase Reports, record an
     override from Currency Settings (a reason is now mandatory), and confirm an
     `exchange_rate_audit` row appears with actor, reason and prior value.
2. **Then resume at Phase 3**, in the order listed above. Do not jump to a later phase or to
   unrelated work.
3. **Working protocol per phase.** Read only that phase's audit section; enumerate the exact
   objects involved; inspect only those; before editing, state current behaviour, why it is
   defective, what changes, what explicitly does not, and which invariants hold; make the
   smallest coherent change; validate; then update **this file** immediately — status table,
   completed-work entry, residual risks and the next milestone.
