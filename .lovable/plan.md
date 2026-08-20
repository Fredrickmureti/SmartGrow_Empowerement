# Receivables, Partners & Purchases reporting — authoritative status (2026-08-20)

## Complete and verified

- **Phase 1–5** (authorization hardening, AR point-in-time parity, Partner Ledger in SQL, Sales analysis engine): verified in earlier sessions.
- **Phase 6 — purchases & payables parity — DONE this session.**
  - Engine (pre-existing, re-verified): `finance_purchase_analysis`,
    `finance_purchase_expense_reconciliation` — SECURITY DEFINER, STABLE,
    pinned `search_path`, `finance_can_read_org` gate, no anon EXECUTE.
  - Client seam `src/services/finance/purchaseAnalysis.ts`,
    `src/hooks/usePurchaseAnalysis.ts`, page `src/pages/reports/PurchaseReports.tsx`.
  - Wiring completed now: `purchases` added to `ReportKind` / `BRANCH_SCOPABLE`
    (branch-sliceable); routes `/finance/reports/purchases` and
    `/purchases/purchase-analysis` (same page, one implementation);
    `purchase-reports` in `REPORT_REGISTRY` (category `payables`, dialog
    drill-down) with relation pairs to `aged-payables` and `sales-reports`;
    "Purchase analysis" link in the Purchases Insights nav.
  - Guards extended: `supabase/tests/reporting_isolation_matrix_test.sql` and
    `src/test/architecture/reporting-isolation-matrix.test.ts` now cover both
    purchase functions (incl. the cross-org `42501` call) and the
    `purchase-reports` family.
  - Verification: `reporting-isolation-matrix` + `purchase-analysis-server-owned`
    → 20 tests passing; full `tsgo --noEmit -p tsconfig.app.json` clean.
    Three unrelated pre-existing failures remain in the wider architecture suite
    (`no-deprecated-payroll-tables-read`, `bank-export-template-metadata`) —
    untouched by this phase.

## Still open

- **Signed-in smoke test of the sales and purchase engines against live data.**
  The read-only query role is denied EXECUTE by design, so
  `finance_sales_revenue_reconciliation` and
  `finance_purchase_expense_reconciliation` must be run from an authenticated
  session for a past period; a non-zero variance is a bookkeeping finding to
  investigate, never a report to tune.
- Phase 7 (report taxonomy closure): drill-down isolation tests across
  org / business / branch for the purchases family, matching the sales family.
