# Receivables & Partners Reporting — Phase 4 completion (Sales Analysis)

Authoritative status document. Update at the end of every phase.

## Handover verification (this session)

- **Phases 1–3 — VERIFIED previously, not redone.** Authorization hardening,
  AR point-in-time engines, and the SQL-owned Partner Ledger
  (`finance_partner_ledger`, `finance_partner_ledger_reconciliation`,
  `src/services/finance/partnerLedger.ts`, `src/hooks/usePartnerLedger.ts`,
  `supabase/tests/partner_ledger_engine_test.sql`,
  `src/test/architecture/partner-ledger-server-owned.test.ts`) all exist.
- **Phase 4.2 / 4.3 — VERIFIED FACT.** Queried the live catalog:
  `finance_sales_analysis(_org_id, _from, _to, _business_id, _branch_id,
  _dimension, _limit, _offset)` and `finance_sales_revenue_reconciliation(
  _org_id, _from, _to, _business_id, _branch_id)` both exist, are
  `SECURITY DEFINER`, pin `search_path=public`, call `finance_can_read_org`,
  and are **not** executable by `anon`. Migration
  `20260820103610_*.sql` and regenerated `types.ts` confirm.
- **Client seam — VERIFIED ABSENT.** No `src/services/finance/salesAnalysis.ts`,
  no `src/hooks/useSalesAnalysis.ts`.
- **Page — VERIFIED UNCHANGED.** `src/pages/reports/SalesReports.tsx` still
  calls `useInvoices()` and aggregates in the browser
  (`reduce` on `inv.total`, status-string filtering, `Record<string,…>` grouping,
  JS monthly breakdown, JS export footer). It is an invoice-activity dashboard,
  not a revenue report: no credit notes, no returns, no discounts, no cost or
  margin, no base-currency normalisation, no GL tie-out.
- **Guards — VERIFIED ABSENT.** No `supabase/tests/sales_analysis_engine_test.sql`,
  no sales-analysis architecture test.
- **Plan file — was stale.** It listed 4.1 done and 4.2–4.5 pending; 4.2 and 4.3
  are in fact done. Corrected here.

## ▶ ACTIVE — Phase 4 remainder

### 4.4 Client seam
`src/services/finance/salesAnalysis.ts` — the only caller of both RPCs, typed
rows + totals envelope + reconciliation result, modelled on `partnerLedger.ts`
(module doc explaining why no aggregation may return to the browser).
`src/hooks/useSalesAnalysis.ts` — React Query hooks keyed on
org / business / branch / period / dimension / paging, following `useApAging`
and `usePartnerLedger`.

### 4.5 Page rebuild — `src/pages/reports/SalesReports.tsx`
- Delete `useInvoices()`, the `salesData` `useMemo`, all `reduce` arithmetic and
  the hand-built export payload.
- Dimension selector: customer / product / category / branch / salesperson /
  month, carried in the URL through the existing `useReportWorkspaceState`
  (so drill-down and Back keep the chosen dimension).
- Columns straight from the engine: gross, discount, net sales, tax, returns,
  net after returns, cost, margin, margin %, quantity, document count; totals
  row from the engine's envelope, never summed client-side.
- Variance banner from `finance_sales_revenue_reconciliation`: shows document
  net sales vs GL revenue less returns and discounts; a non-zero variance is
  surfaced as a bookkeeping finding, never hidden or tuned away.
- Export/PDF via `toExportColumns` / `toExportRows` over the same dataset;
  export re-runs the RPC unpaged rather than re-aggregating the visible page.
- Drill-down: dimension row → underlying documents, through existing scoped
  hooks only.

### 4.6 Guards
- `supabase/tests/sales_analysis_engine_test.sql` — one definition each,
  definer + pinned search_path + org gate + no anon EXECUTE, cross-org call
  raises `42501`, dimension whitelist rejects arbitrary input, branch/business
  scoping, voided and unposted invoices excluded, returns subtracted, totals
  envelope equals the sum of rows.
- `src/test/architecture/sales-analysis-server-owned.test.ts` — the page holds
  no invoice-total arithmetic, no `useInvoices` import, no local export payload
  construction; the service is the only RPC caller.

### 4.7 Verification before closing Phase 4
Typecheck, run the new SQL contract test and the architecture suites, and from
an authenticated session smoke-test both RPCs for a closed month. Record what
was verified, not what was written.

## Phase 5 — Report taxonomy & security closure (not started)
Direct-RPC and drill-down isolation tests for all four reports across
org / business / branch, plus the cross-org membership matrix, and a dedicated
pass over the security-linter baseline for this report family.

## Notes
- No second reporting engine: the design-system report primitives
  (`ReportSurface`, `ReportTable`, `toExportColumns`/`toExportRows`) stay the
  only presentation layer.
- No accounting arithmetic in React. All measures come from SQL in base currency.
