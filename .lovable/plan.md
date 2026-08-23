# Analytic Accounting — Implementation Status

## Currently active phase
**Phase 5 — Consumers / reporting.** Now essentially complete (see pending item below).

## Fully implemented and verified

### Phase 4 — Producers (GL attribution)
- Triggers propagate analytic attribution from projects, bills, invoices and expenses into `journal_entry_line_analytics`.
- Project → analytic account resolution happens in the database.

### Phase 5 — Consumers
- RPCs installed and hardened (`SECURITY DEFINER`, business + `financials:read` checks, posted/reversed only):
  `analytic_account_statement`, `analytic_profit_and_loss`, `analytic_budget_vs_actual`, `project_analytic_reconciliation`.
- `src/hooks/finance/useAnalyticReports.ts` — four typed hooks, scope-aware query keys.
- Report pages:
  - `src/pages/reports/AnalyticAccountStatement.tsx` (existing)
  - `src/pages/reports/AnalyticProfitAndLoss.tsx` (new)
  - `src/pages/reports/AnalyticBudgetVsActual.tsx` (new)
- Routes registered in `src/apps/finance/routes.tsx`:
  `/finance/reports/analytic-statement`, `/finance/reports/analytic-profit-and-loss`, `/finance/reports/analytic-budget-vs-actual`.
- Registry entries in `src/services/reports/ReportRegistry.ts` (category `management`, related-report links to GL / P&L / Budget vs Actual) and nav entries under the `analytics` family in `src/services/reports/reportsNav.ts`.

### Analytic budget planning
- Migration: `budget_items` unique index on `(budget_id, account_id, period_month, analytic_account_id)` with `NULLS NOT DISTINCT`; `_budget_items_normalize` validates the analytic account belongs to the same business and is `active`.
- `src/hooks/useBudgets.ts`: `analytic_account_id` in types, select, create, diff-based update (line key includes the dimension) and the upsert conflict target.
- `src/features/finance/budgets/BudgetEditPage.tsx`: optional "Cost centre / project" picker (postable dimensions only) in the line composer and a column on the lines table.

Verification done: `tsgo --noEmit` clean; `src/test/architecture/reports-routing-parity.test.ts` passes.

## Pending
- `src/test/architecture/reports-nav-registry-driven.test.ts` has 2 failing assertions about **inventory dual-host report paths**
  (`/finance/reports/inventory-valuation`, `stock-ledger`, `stock-aging`, `lot-traceability` resolve via `paths`, not `path`).
  This is unrelated to the analytic work — confirm whether it pre-exists and fix the guard/registry accordingly.
- Full `vitest run` was not completed (suite exceeds the command timeout); run it in shards.

## Next milestone (Phase 6 — integrity & governance)
1. Verify Phase 5 first: open the three analytic reports with real data, confirm they tie to the GL (statement closing balances vs `general_ledger`, analytic P&L ≤ statutory P&L), and confirm budget lines with a dimension flow into Analytic Budget vs Actual.
2. Then continue chronologically: analytic integrity checks (unattributed-posting exception report, drift monitor between GL analytic ledger and project ledger surfaced outside the statement page), and analytic mandatory-attribution policy per plan/account.

## Instructions for the next agent
Before writing new code, verify the work above: read the three report pages, the registry/nav entries and the budget hook edits, run `tsgo --noEmit`, and run the reporting architecture tests. Only after that, resume at Phase 6 step 1. Do not start unrelated domains.
