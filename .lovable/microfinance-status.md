# Microfinance convergence — live status (2026-09-02)

Plan of record: `.lovable/plan/smart-grow-empowerment-microfinance-convergence-plan-reworke-2026-09-02.md`

Done: C1–C8b, **V1 live lifecycle proof: PASS**, and **C9 reports: DONE**.

## C9 reports — verified

Four lending reports built on the inherited report engine (`ReportPageLayout`
+ `design-system/reports`), so export/PDF and institution branding are
inherited, not rebuilt. Every figure is server-derived (`mf_loan_balances`,
`mf_loan_arrears`, `mf_par_summary`, `mf_repayments`, `mf_loan_disbursements`).

- `src/hooks/useMfReports.ts` — portfolio, collections, disbursements reads.
- `src/apps/lending/reports/{PortfolioReport,ArrearsReport,CollectionsReport,DisbursementsReport}.tsx`
- Registered: new `lending` reporting domain + label + `/lending/reports`
  path prefix, four entries in `ReportRegistry`, routes in
  `src/apps/lending/routes.tsx`, "Insights" group in `src/apps/lending/nav.ts`.
- Removed stale ERP ids `sales-reports` / `purchase-reports` from
  `reportsNav.ts` and the isolation-matrix test (those reports no longer
  exist in the registry — the guards were failing before this pass).

Verification: `tsgo --noEmit` clean for all touched files;
`reports-routing-parity`, `reports-nav-registry-driven`,
`reporting-workspace`, `reporting-isolation-matrix` → 64/64 pass.

## Next

1. **C9 documents** — loan agreement, repayment schedule, loan statement,
   payment receipt registered on the existing document engine (no new
   renderer, no new PDF path).
2. **C10** — `mf_*` RLS/grants hardening + security scan, then the single
   bulk ERP removal sweep (POS/retail, inventory, warehouse, procurement,
   order-to-cash, CRM, payroll, attendance, non-retained finance surfaces).
   The ~3,675 inherited linter findings are addressed there — none originate
   in `mf_*`.
