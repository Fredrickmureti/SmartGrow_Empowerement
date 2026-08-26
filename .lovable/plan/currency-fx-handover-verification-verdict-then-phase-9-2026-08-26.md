# Currency & FX — handover verification verdict, then Phase 9

Baseline audit: `docs/audits/currency-architecture-audit.md`.
Predecessor status file: `.lovable/plan.md` (superseded by this document).

## A. What the previous work actually established (verified, not assumed)

Checked directly against the live database and the codebase this turn:

- One rate engine is real and intact: `_pick_exchange_rate_row` → `resolve_exchange_rate`
  → `require_exchange_rate` → `fx_stamp_document`, plus `describe_exchange_rate`.
- Phase 3 stamping is genuinely done. Every rate-bearing transactional table now carries a
  currency-stamping trigger: invoices, credit notes, estimates, sales orders, bills,
  bill payments, bank transactions, POs, purchase returns, vendor credit notes,
  RFQ quotations, landed-cost vouchers, customer refunds, procurement contracts.
- Phase 2 rate-book integrity is done: `exchange_rates` has only `select` and `insert`
  policies (no UPDATE, no DELETE — evidence cannot be destroyed), insert is gated by
  `is_finance_manager`, and `_tg_exchange_rates_audit` / `_immutable` / `_write_guard`
  triggers exist with an `exchange_rate_audit` table. S1 is closed.
- Phase 5 lifecycle is done: `business_currency_readiness` and
  `change_business_base_currency` exist; the journal-entry hard lock is untouched.
- Phase 4 coverage is done: `fx_rate_coverage` / `fx_rate_coverage_summary` exist and are
  read by `useFxRateCoverage.ts` + `FxRateCoverageCard.tsx` (read-only, no client math).
- Phase 6/7 code is present and typechecks clean (`tsgo --noEmit` passes):
  fixed-asset currency UI, `src/lib/currency/catalogue.ts` and its edge mirror.

Also confirmed: `.lovable/plan/currency-architecture-remediation-implementation-tracker-2026-08-26.md`
is **stale** (claims Phases 2–9 NOT STARTED). The database contradicts it. This file
becomes the single source of truth; the tracker will be marked superseded, not deleted.

## B. What the verification found still open (evidence, not claim)

1. **Phase 1 is incomplete — two live functions still invent a 1:1 rate.**
   `get_salesperson_performance` and `get_salesperson_performance_documents` still contain
   `COALESCE(NULLIF(<rate>, 0), 1)`. They are consumed by `src/hooks/useSalespersonDashboard.ts`.
   Phase 1 fixed four reporting functions and missed these two. No view carries the pattern.
2. **D15 is only half closed.** The partial unique index exists
   (`fx_revaluation_runs_one_open_per_period` on `(business_id, fiscal_period_id) WHERE status='posted'`),
   but `revalue_fx_balances` contains no advisory lock, and the index does not bind when
   `fiscal_period_id IS NULL`. Two concurrent period-less runs can still double-post.
3. **S2 confirmed latent.** `exchange_rates_select` is
   `user_can_access_business(auth.uid(), business_id)`, so organization-scoped rows
   (business-null) that the server engine legitimately resolves are invisible to the client
   mirror — the UI can show "no rate" for a rate that will in fact be stamped.
4. **Rate-bearing tables with no stamping trigger:** `expenses`, `pos_payment_sessions`,
   `project_cost_entries`, `project_revenue_entries`. Whether each is an accounting event
   in a foreign currency is not yet established — this needs a read, not an assumption.
5. **No build-level ratchet.** The architecture-test suite has no test that fails the build
   when a new SQL object introduces `COALESCE(<rate>, 1)`, a hardcoded currency symbol, or
   a hardcoded 2-decimal money format.

## C. What I will not touch

Posted amounts, stamped rates, GL history, closed periods, the base-currency journal lock.
No books-conversion feature. No second rate engine. No branch functional currency.
No renames for style. No unrelated module work.

## D. Plan — Phase 9, in dependency order

**9.0 Close the Phase 1 residue (D1 leftover).**
Migration: replace the invented rate in `get_salesperson_performance` and
`get_salesperson_performance_documents` with the existing `fx_report_document_rate` helper,
exclude unconvertible rows from measures and report an explicit unconvertible count —
identical to the pattern Phase 1 already established. Update
`useSalespersonDashboard.ts` and its dashboard consumer to render the absence, never a zero.

**9.1 D15 — revaluation concurrency.**
Migration: take a transaction-scoped advisory lock keyed on
`(business_id, run_date/fiscal_period)` at the top of `revalue_fx_balances`, and the same
key in `reverse_fx_revaluation_run` so a reversal cannot interleave with a run. Keep the
partial unique index and extend the guard to cover period-less runs. Behaviour on
contention: refuse with an explicit "a revaluation is already running" error — never queue,
never post twice.

**9.2 S2 — organization-scoped rate visibility.**
Widen `exchange_rates_select` so a member can read the organization-scoped rows that apply
to their business (read-only; insert stays finance-manager-gated). Verify the client mirror
then shows the same rate the server would stamp.

**9.3 Establish the four unstamped tables.**
Read each write path (`expenses`, `pos_payment_sessions`, `project_cost_entries`,
`project_revenue_entries`) and decide per table: it is base-currency-only by construction
(document it and add a check), or it is a foreign-currency accounting event (add the
`fx_stamp_document` trigger + posted-immutability guard). No trigger added speculatively.

**9.4 Currency-disable guard.**
Confirm server-side that `set_business_active_currency` refuses to disable a currency with
open AR/AP, a bank account, or an unposted draft in that currency; add the refusal if it is
missing. Deactivation semantics only — never deletion.

**9.5 The ratchet (regression protection).**
New architecture tests, run against pg catalog snapshots and the source tree:
no `COALESCE(<rate>, 1)` in any `pg_proc` body or view definition; every rate-bearing table
either has a stamping trigger or is on a documented base-currency-only allowlist; every
currency/rate table write policy carries a role predicate; no module re-introduces a private
currency-symbol map or a hardcoded money decimal count.

Each step: smallest coherent change, targeted validation, then this file updated.

## E. Technical notes

Migrations use `CREATE OR REPLACE FUNCTION` with `SET search_path = public` and preserve
existing grants. No table in `public` is created without matching `GRANT` statements.
Validation per step: `tsgo --noEmit`, the relevant `src/test/architecture` suites
(`fx-single-engine`, `currency-integrity`, `report-format-parity`), and before/after SQL
totals proving that documents which already have a rate report identically.
