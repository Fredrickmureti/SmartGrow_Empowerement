# Analytic Accounting — Implementation Status

## Status: Phase 5 CLOSED ✅

All Phase 4 (producers) and Phase 5 (consumers / reporting) work is implemented and verified.
No open items remain in this plan.

## Delivered

### Phase 4 — Producers (GL attribution)
- Triggers propagate analytic attribution from projects, bills, invoices and expenses into
  `journal_entry_line_analytics`.
- Project → analytic account resolution happens in the database.

### Phase 5 — Consumers
- Hardened RPCs (`SECURITY DEFINER`, business + `financials:read` checks, posted/reversed only):
  `analytic_account_statement`, `analytic_profit_and_loss`, `analytic_budget_vs_actual`,
  `project_analytic_reconciliation`.
- `src/hooks/finance/useAnalyticReports.ts` — four typed, scope-aware hooks.
- Report pages: `AnalyticAccountStatement.tsx`, `AnalyticProfitAndLoss.tsx`,
  `AnalyticBudgetVsActual.tsx`.
- Routes in `src/apps/finance/routes.tsx`: `/finance/reports/analytic-statement`,
  `/finance/reports/analytic-profit-and-loss`, `/finance/reports/analytic-budget-vs-actual`.
- Registry entries (`ReportRegistry.ts`, category `management`) and nav entries under the
  `analytics` family (`reportsNav.ts`).

### Analytic budget planning
- Migration: `budget_items` unique index on
  `(budget_id, account_id, period_month, analytic_account_id)` with `NULLS NOT DISTINCT`;
  `_budget_items_normalize` validates the analytic account is same-business and `active`.
- `useBudgets.ts`: analytic dimension in types, select, create, diff-based update and upsert
  conflict target.
- `BudgetEditPage.tsx`: optional "Cost centre / project" picker plus a lines-table column.

### Final cleanup (reporting nav guards)
- `purchase-reports` added to the `subledgers` nav family — it was registered and routed but
  unreachable from the sidebar.
- `reports-nav-registry-driven.test.ts` now resolves dual-host reports through
  `reportMountPaths()` (and tolerates query strings), so inventory reports mounted under both
  `/finance/reports/*` and `/inventory-app/reports/*` validate correctly.

## Verification
- `tsgo --noEmit` clean.
- `src/test/architecture/reports-routing-parity.test.ts` — 42 passing.
- `src/test/architecture/reports-nav-registry-driven.test.ts` — 5 passing (was 2 failing).

## Next milestone (new plan required) — Phase 6: integrity & governance
1. Smoke-check the three analytic reports against real data (statement closing balances vs
   `general_ledger`; analytic P&L ≤ statutory P&L; dimensioned budget lines appear in
   Analytic Budget vs Actual).
2. Analytic integrity checks: unattributed-posting exception report; drift monitor between the
   GL analytic ledger and the project ledger, surfaced outside the statement page.
3. Analytic mandatory-attribution policy per plan / account.
