# Receivables & Partners Reporting — status and roadmap

Authoritative status document. Update at the end of every phase.
Record what was **verified**, not what was written.

---

## Completed and verified

### Phase 1 — Authorization hardening — ✅ DONE (verified earlier sessions)
`get_control_account_reconciliation`, `get_ar_summary`, `get_ap_summary`,
`get_ar_ap_aging_from_ledger`: single definition, `SECURITY DEFINER`, pinned
`search_path`, `finance_can_read_org` gate, no `anon` EXECUTE.
Guard: `supabase/tests/receivables_reporting_authorization_test.sql`.

### Phase 2 — Receivables point-in-time parity — ✅ DONE (verified)
`finance_ar_open_items_as_of`, `finance_ar_customer_credit_as_of`,
`finance_ar_aging_reconciliation` + `src/services/finance/openItems.ts`.

### Phase 3 — Partner Ledger in SQL — ✅ DONE (verified)
`finance_partner_ledger`, `finance_partner_ledger_reconciliation`,
`src/services/finance/partnerLedger.ts`, `src/hooks/usePartnerLedger.ts`,
`supabase/tests/partner_ledger_engine_test.sql`,
`src/test/architecture/partner-ledger-server-owned.test.ts` (10 tests green).

### Phase 4 — Sales Reports as a real accounting report — ✅ COMPLETE (this session)

| Item | State | Evidence |
| --- | --- | --- |
| 4.1 Taxonomy verdict (one report, six dimensions) | done | encoded as `_dimension` on one engine |
| 4.2 `finance_sales_analysis` | verified in live catalog | definer, `search_path=public`, `finance_can_read_org`, no anon EXECUTE |
| 4.3 `finance_sales_revenue_reconciliation` | verified in live catalog | same hardening; posted JEs only; reports `variance` / `in_balance` |
| 4.4 Client seam | done | `src/services/finance/salesAnalysis.ts` (only RPC caller) + `src/hooks/useSalesAnalysis.ts` |
| 4.5 Page rebuild | done | `src/pages/reports/SalesReports.tsx`: no `useInvoices`, no `reduce`, engine totals footer, URL-owned dimension (`group` scope key), GL variance banner, export over the same unpaged dataset, customer drill-down via `DrillDownDialog` |
| 4.6 Guards | done | `supabase/tests/sales_analysis_engine_test.sql`, `src/test/architecture/sales-analysis-server-owned.test.ts` (8 tests green) |
| 4.7 Verification | partial — see below | typecheck clean, build OK, architecture suites green |

**Verified facts (queried against the live catalog, not assumed):** both sales
functions are `SECURITY DEFINER` with `search_path=public`, call
`finance_can_read_org`, are **not** executable by `anon`; the analysis body
excludes unposted (`journal_entry_id IS NOT NULL`) and voided documents,
normalises through `exchange_rate`, subtracts `credit_note_items`, and scopes
business/branch strictly (no `OR branch_id IS NULL` leak); the reconciliation
body uses the `sales_revenue` / `sales_returns` / `discount_given` account roles
over posted journal entries and reports a variance.

**Design decisions recorded:** drill-down is offered only on the *customer*
dimension, where a document-ownership relationship actually exists (partner
invoices via `DrillDownDialog`); product / category / branch / salesperson /
month are groupings and deliberately have no fabricated drill path. The export
does not re-run the RPC because the page queries the engine unpaged — the
exported rows are the same dataset and the same column declaration.

**Open verification item (not a defect, an access limitation).** A live
numeric smoke test of both RPCs could not be run: the read-only query role is
correctly denied EXECUTE, and this project's Supabase is external/unmanaged so
no authenticated browser session can be injected. **Next agent: sign in to the
preview and open `/finance/reports/sales`,** confirm for a closed month that
(a) rows render per dimension, (b) the totals footer equals the engine
envelope, (c) the reconciliation banner shows `in_balance = true` or a variance
that is investigated as a bookkeeping finding — never tuned away.

---

## ▶ NEXT — Phase 5 — Report taxonomy & security closure (not started)

1. **Direct-RPC isolation matrix.** For all four report families (AR aging, AP
   aging, Partner Ledger, Sales Analysis): cross-org call raises `42501`,
   business scoping cannot be widened by passing `NULL`, branch scoping is
   strict, and no function is reachable by `anon`. One SQL suite,
   `supabase/tests/reporting_isolation_matrix_test.sql`.
2. **Drill-down isolation.** `DrillDownDialog` reads must be org/business
   scoped for every entry point that now uses it, including the new sales
   customer drill.
3. **Registry coverage.** Every routed report page in this family has a
   `REPORT_REGISTRY` entry with domain + related reports, so the switcher and
   Report Center cannot drift from the routes.
4. **Security-linter pass** over this report family; record accepted findings
   in security memory rather than leaving them open.

## Notes
- No second reporting engine: `ReportSurface` / `ReportTable` /
  `toExportColumns` / `toExportRows` remain the only presentation layer.
- No accounting arithmetic in React. All measures come from SQL in base
  currency.
- Ledger `debit`/`credit` are already base currency — never add FX conversion
  on top of them (document currency lives in `original_debit`/`original_credit`).

## Instructions for the next agent
1. **Verify before continuing.** Re-check Phase 4 against the codebase and the
   live catalog (not this file): the page holds no invoice arithmetic, the
   service is the only RPC caller, both guard suites pass, and the two SQL
   functions still carry definer + pinned search_path + org gate + no anon
   EXECUTE. Then clear the open verification item above from a signed-in
   session.
2. **Then start Phase 5, item 1.** Do not open unrelated report families or
   leave a phase half-shipped: each phase lands SQL + client seam + page +
   export + tests together.
