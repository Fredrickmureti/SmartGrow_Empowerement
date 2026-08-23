/**
 * Analytic reporting hooks (Phase 5 — consumers).
 *
 * CONTRACT
 * --------
 * Every number rendered by the three analytic reports is computed by the
 * database:
 *   - `analytic_account_statement`  → line-level movement + running balance
 *   - `analytic_profit_and_loss`    → income / expense per analytic account
 *   - `analytic_budget_vs_actual`   → budget line vs analytic actual
 *   - `project_analytic_reconciliation` → GL analytic ledger vs project ledger
 *
 * The client selects an axis (plan / analytic account / period / branch) and
 * renders rows. It never sums a subledger in the browser: totals shown on the
 * pages are footer roll-ups of already server-aggregated rows, which is a
 * presentation concern, not a second aggregation path.
 *
 * All four RPCs are SECURITY DEFINER and enforce
 * `user_can_access_business` + `financials:read` internally, and only read
 * journal entries in status `posted` / `reversed`, so a report can never
 * disclose data the caller cannot see nor count a draft entry.
 */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFinanceScope } from "./useFinanceScope";
import { financeKey } from "@/lib/finance/financeKey";

export interface AnalyticStatementRow {
  journal_entry_id: string;
  journal_entry_line_id: string | null;
  entry_number: string | null;
  entry_date: string;
  status: string;
  source_type: string | null;
  reference: string | null;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  analytic_account_id: string;
  analytic_code: string | null;
  analytic_name: string;
  plan_id: string;
  plan_name: string;
  branch_id: string | null;
  description: string | null;
  debit: number;
  credit: number;
  amount: number;
  running_balance: number;
}

export interface AnalyticPnLRow {
  analytic_account_id: string;
  analytic_code: string | null;
  analytic_name: string;
  plan_id: string;
  plan_name: string;
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: string;
  amount: number;
  income: number;
  expense: number;
  margin: number;
}

export interface AnalyticBudgetRow {
  analytic_account_id: string;
  analytic_code: string | null;
  analytic_name: string;
  plan_id: string;
  plan_name: string;
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: string;
  budgeted: number;
  actual: number;
  variance: number;
  variance_pct: number | null;
}

export interface ProjectAnalyticReconciliationRow {
  project_id: string;
  project_number: string | null;
  project_name: string;
  analytic_account_id: string | null;
  gl_analytic_net: number;
  project_ledger_cost: number;
  project_ledger_revenue: number;
  project_ledger_net: number;
  difference: number;
}

interface Range {
  dateFrom: string;
  dateTo: string;
}

function num(v: unknown): number {
  return Number(v) || 0;
}

/** Line-level analytic statement, optionally narrowed to one account/plan. */
export function useAnalyticAccountStatement(
  { dateFrom, dateTo }: Range,
  analyticAccountId: string | null,
  planId: string | null,
) {
  const scope = useFinanceScope();

  return useQuery({
    queryKey: financeKey(
      scope,
      "analytic-statement",
      dateFrom,
      dateTo,
      analyticAccountId ?? "all",
      planId ?? "all",
    ),
    queryFn: async (): Promise<AnalyticStatementRow[]> => {
      if (!scope.businessId) return [];
      const { data, error } = await (supabase as any).rpc("analytic_account_statement", {
        p_business_id: scope.businessId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_analytic_account_id: analyticAccountId,
        p_plan_id: planId,
        p_branch_id: scope.rpcBranchId,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        debit: num(r.debit),
        credit: num(r.credit),
        amount: num(r.amount),
        running_balance: num(r.running_balance),
      })) as AnalyticStatementRow[];
    },
    enabled: !!scope.businessId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** P&L by analytic account — income / expense accounts only. */
export function useAnalyticProfitAndLoss({ dateFrom, dateTo }: Range, planId: string | null) {
  const scope = useFinanceScope();

  return useQuery({
    queryKey: financeKey(scope, "analytic-pnl", dateFrom, dateTo, planId ?? "all"),
    queryFn: async (): Promise<AnalyticPnLRow[]> => {
      if (!scope.businessId) return [];
      const { data, error } = await (supabase as any).rpc("analytic_profit_and_loss", {
        p_business_id: scope.businessId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_plan_id: planId,
        p_branch_id: scope.rpcBranchId,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        amount: num(r.amount),
        income: num(r.income),
        expense: num(r.expense),
        margin: num(r.margin),
      })) as AnalyticPnLRow[];
    },
    enabled: !!scope.businessId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Budget vs actual per analytic account × GL account. */
export function useAnalyticBudgetVsActual(
  { dateFrom, dateTo }: Range,
  budgetId: string | null,
  planId: string | null,
) {
  const scope = useFinanceScope();

  return useQuery({
    queryKey: financeKey(
      scope,
      "analytic-budget-vs-actual",
      dateFrom,
      dateTo,
      budgetId ?? "all",
      planId ?? "all",
    ),
    queryFn: async (): Promise<AnalyticBudgetRow[]> => {
      if (!scope.businessId) return [];
      const { data, error } = await (supabase as any).rpc("analytic_budget_vs_actual", {
        p_business_id: scope.businessId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_budget_id: budgetId,
        p_plan_id: planId,
        p_branch_id: scope.rpcBranchId,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        budgeted: num(r.budgeted),
        actual: num(r.actual),
        variance: num(r.variance),
        variance_pct: r.variance_pct === null || r.variance_pct === undefined ? null : num(r.variance_pct),
      })) as AnalyticBudgetRow[];
    },
    enabled: !!scope.businessId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Variance panel: GL analytic ledger vs the operational project ledger.
 * The two books are reconciled, never merged — a non-zero difference is a
 * real signal (non-GL project costs such as timesheets, or a posting that
 * missed its analytic attribution).
 */
export function useProjectAnalyticReconciliation({ dateFrom, dateTo }: Range, enabled = true) {
  const scope = useFinanceScope();

  return useQuery({
    queryKey: financeKey(scope, "project-analytic-reconciliation", dateFrom, dateTo),
    queryFn: async (): Promise<ProjectAnalyticReconciliationRow[]> => {
      if (!scope.businessId) return [];
      const { data, error } = await (supabase as any).rpc("project_analytic_reconciliation", {
        p_business_id: scope.businessId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        gl_analytic_net: num(r.gl_analytic_net),
        project_ledger_cost: num(r.project_ledger_cost),
        project_ledger_revenue: num(r.project_ledger_revenue),
        project_ledger_net: num(r.project_ledger_net),
        difference: num(r.difference),
      })) as ProjectAnalyticReconciliationRow[];
    },
    enabled: !!scope.businessId && enabled,
    staleTime: 60_000,
  });
}
