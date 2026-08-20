# Receivables & Partners Reporting — Investigation + Phased Remediation

Authoritative status document. Update at the end of every phase.

---

## Handover verification (this session)

I re-verified every completion claim left by the previous engineer rather than trusting the log.

**Phase 1 — Authorization hardening — ✅ VERIFIED FACT.**
`get_control_account_reconciliation`, `get_ar_summary`, `get_ap_summary`,
`get_ar_ap_aging_from_ledger` are all `SECURITY DEFINER`, carry
`search_path=public`, contain a `finance_can_read_org` membership gate, and grant
EXECUTE only to `authenticated` / `service_role` / `postgres` — **no `anon`**.
`supabase/tests/receivables_reporting_authorization_test.sql` is present.

**Phase 2 — Receivables point-in-time parity — ✅ VERIFIED FACT.**
`finance_ar_open_items_as_of`, `finance_ar_customer_credit_as_of`,
`finance_ar_aging_reconciliation` each exist exactly once, definer, pinned
search_path, org-gated, no anon EXECUTE. `src/services/finance/openItems.ts`
exposes `fetchArOpenItemsAsOf` / `fetchArCustomerCreditAsOf` and
`fetchContactOpenItemAging` serves both sides from the as-of engines.
Guard suites re-run green: `ar-aging-point-in-time`, `aging-single-source`,
`reports-data-source-contract`, `sales-dashboard-projection` — 29 tests passing.

**Not done, as logged — VERIFIED FACT.** `finance_partner_ledger` does not exist
in the database; `src/pages/reports/PartnerLedger.tsx` (456 lines) still pages
`customer_ledger_entries` / `vendor_ledger_entries` in an unbounded
`while(true) … .range()` loop and computes opening / running / closing balances in
JavaScript. Phase 4 (Sales Reports) untouched.

**Open verification item (INFERENCE, not fact).** The live-data reconciliation
spot-check the previous engineer prescribed could not be executed: the read-only
query role is denied EXECUTE on `finance_ar_aging_reconciliation` (correct
hardening, wrong role for the check). It must be run from an authenticated
session as the first task of Phase 3.

---

## New findings added to the plan (Phase 2 validation & expansion)

These come from reading `PartnerLedger.tsx` and `SalesReports.tsx` directly and
were **not** in the previous plan:

1. **Partner Ledger has no currency normalisation (accounting defect).** It sums
   `debit`/`credit` straight from the ledger views with no base-currency
   conversion, then labels the output with `baseCurrency`. A partner with any
   foreign-currency document produces a meaningless mixed-unit balance.
2. **Branch filter semantics are wrong for a ledger.** The page applies
   `or(branch_id.eq.X, branch_id.is.null)`, so a branch-scoped partner ledger
   silently absorbs every unbranched entry. This must match whatever the aging
   engine does — one definition, verified, not two.
3. **No control-account tie-out for the partner ledger closing balance.** AR/AP
   aging now has `finance_ar/ap_aging_reconciliation`; the partner ledger has no
   equivalent, so nothing proves its closing balance equals the AR/AP control
   account for the same period.
4. **Unbounded fetch is a real performance/correctness cliff.** Two full-history
   scans per render with no server-side limit; large tenants will time out
   client-side and silently render a partial ledger.
5. **Sales Reports mixes measures (defect, Phase 4).** It aggregates `invoices`
   totals client-side, ignores credit notes and returns, and does no FX
   normalisation while presenting figures as base currency — it is not a revenue
   report and must not be described as one until rebuilt.

---

## ▶ ACTIVE — Phase 3 — Partner Ledger balances in SQL

**3.0 Verify accounting truth first.** From an authenticated session, run
`finance_ar_aging_reconciliation(org, business, NULL, <a past month-end>)` and the
AP twin. `in_balance = true` expected; a non-zero `variance` is a real finding —
investigate the cause (missing control-account posting, FX gap), never tune the
report to match. Confirm `get_ar_summary` and Aged Receivables agree for the same
as-of date, and that a past as-of date is stable across days.

**3.1 `finance_partner_ledger(_org, _business, _branch, _contact, _side, _from,
_to, _limit, _offset)`.** Returns opening balance, paged movements with a SQL
running balance, and closing balance — all in **base currency** via the
`resolve_exchange_rate` / `require_exchange_rate` authority (ADR 0135/0136; never
a fabricated 1:1). Definer, pinned `search_path`, `finance_can_read_org` gate, no
anon EXECUTE. Branch predicate identical in meaning to the aging engine.

**3.2 `finance_partner_ledger_reconciliation(...)`** — closing balance vs the
AR/AP control account at `_to`, mirroring the aging reconciliation functions.

**3.3 Repoint the page.** Typed hook in `src/services/finance/` +
`src/hooks/usePartnerLedger.ts` following the `useApAging` pattern. Delete the JS
paging loop and all balance arithmetic from `PartnerLedger.tsx`.

**3.4 Export.** Re-run the RPC unpaged (the Aged Payables export pattern); never
re-aggregate the visible page. UI and PDF/XLSX consume the same dataset.

**3.5 Tests.**
- `supabase/tests/partner_ledger_test.sql` — one definition, hardening, cross-org
  call raises `42501`, opening + movements + closing tie to the control account,
  FX-normalised totals, branch scoping.
- `src/test/architecture/partner-ledger-server-owned.test.ts` — the page holds no
  `.reduce(` balance maths, no `while (true)` / unbounded `.range(` loop, and no
  direct read of `customer_ledger_entries` / `vendor_ledger_entries`.

## Phase 4 — Sales Reports as a real accounting report (not started)

Rebuild on GL/dimensional sources including credit notes, returns and
base-currency normalisation; drop the bespoke export payload in favour of the
report engine's. Establish the taxonomy verdict (which of customer / product /
category / branch / salesperson are dimensions of one report vs separate
families) with evidence before building pages.

## Phase 5 — Report taxonomy & security closure (not started)

Direct-RPC and drill-down isolation tests for all four reports across
org / business / branch, plus the cross-org membership matrix.

---

## Instructions for the next agent

1. Phases 1 and 2 are verified complete — do not redo them.
2. Execute Phase 3 in order, starting with 3.0. Do not start Phase 4 until
   Phase 3 is complete end to end (SQL + tie-out + page + export + tests).
3. Keep this file current; record what was *verified*, not what was written.
