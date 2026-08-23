# Analytic Accounting — Phase 5 completion (consumers)

## Verified state (checked in code and live database)

- RPCs exist and are SECURITY DEFINER, `search_path` pinned, authorized via `user_can_access_business` + `financials:read`: `analytic_account_statement`, `analytic_profit_and_loss`, `analytic_budget_vs_actual`, `project_analytic_reconciliation`.
- `budget_items.analytic_account_id` exists with FK to `analytic_accounts` (`ON DELETE RESTRICT`).
- `src/hooks/finance/useAnalyticReports.ts` implements four hooks matching the live RPC signatures.
- `src/pages/reports/AnalyticAccountStatement.tsx` exists but is **not routed and not registered** — no `analytic*` entry in `ReportRegistry.ts`, `reportsNav.ts`, or `src/apps/finance/routes.tsx`.
- No UI anywhere writes `budget_items.analytic_account_id` (no `analytic` reference in `useBudgets.ts` or the budget pages), so Budget vs Actual currently has no budget side.
- `budget_items` still has `UNIQUE (budget_id, account_id, period_month)` — it excludes the analytic dimension, so two plan lines for the same account/month with different cost centres cannot coexist.

## Work to do, in order

### 1. Database (one migration)
- Replace `budget_items_budget_id_account_id_period_month_key` with a unique index on `(budget_id, account_id, period_month, analytic_account_id)` using `NULLS NOT DISTINCT`, so an analytic dimension is part of the plan line's natural key.
- Extend `_budget_items_normalize()` to validate `analytic_account_id`: it must exist, belong to the same business as the budget, and be `active` (archived/restricted accounts cannot receive new plan lines). All existing behaviour preserved verbatim.

### 2. Budget UI writes the analytic dimension
- `useBudgets.ts`: add `analytic_account_id` to `BudgetItem`, `BudgetLineInput`, create/update diff key (`account|month|analytic`), and to `upsertBudgetItem` (`onConflict: budget_id,account_id,period_month,analytic_account_id`).
- `BudgetEditPage.tsx`: add an optional "Cost centre / project" select to the add-line composer and show the analytic account on each existing line. Only `active` analytic accounts are offered.

### 3. Two remaining report pages
- `src/pages/reports/AnalyticProfitAndLoss.tsx` — income/expense/margin per analytic account × GL account, plan and period filters, export config, grouped rows with server-computed amounts only.
- `src/pages/reports/AnalyticBudgetVsActual.tsx` — budget vs actual vs variance per analytic account, with budget and plan filters.
- Both follow the existing `ReportPageLayout` + `ReportFilterProvider` + `CompanyScopeGate` pattern used by the statement page; no browser aggregation.

### 4. Register and route all three
- `ReportRegistry.ts`: `analytic-statement`, `analytic-pnl` (category `management`), `analytic-budget-vs-actual` (category `budget`), paths `/finance/reports/analytic-statement`, `/analytic-pnl`, `/analytic-budget-vs-actual`, permission `viewReports`.
- `reportsNav.ts`: add the three ids to the `analytics` family.
- `src/apps/finance/routes.tsx`: lazy imports plus three `SubscriptionProtectedRoute` + `LazyRoute` entries matching the registry paths exactly.

### 5. Close out
- Update `.lovable/plan.md` status table: Phase 5 done, Phase 6 (architecture test forbidding client-side analytic aggregation + live post/void round trip) next.

## Out of scope (unchanged)

User-defined unlimited dimensions, a separate analytic budget engine, stored analytic balances, statistical postings without a GL counterpart, automatic distribution-rule engines.
