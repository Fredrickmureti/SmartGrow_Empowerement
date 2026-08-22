/**
 * Budget vs Actual — presentation layer over the authoritative database report.
 *
 * The numbers are NOT derived here. `get_budget_variance_report` is the single
 * definition of a budget "actual": it reads posted, non-closing, non-opening,
 * non-sample journal activity inside the business's own monthly fiscal
 * periods, inside the budget's business/branch scope, with the account's
 * normal balance direction applied, and it is authorised per caller.
 *
 * Variance sign convention (set in SQL, not here): positive is always
 * FAVOURABLE — spending less than planned on a cost account, or earning more
 * than planned on a revenue account.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBudgets, Budget } from "./useBudgets";

export type BudgetVarianceStatus = "favourable" | "unfavourable" | "on_track";

/** Threshold, in percent of plan, before a variance is called out. */
const MATERIALITY_PCT = 10;

export interface BudgetVarianceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  /** Calendar month of the accounting period (1–12), for display only. */
  month: number;
  /** Position of the period inside the budget's fiscal year (1 = first month). */
  periodOrdinal: number;
  fiscalPeriodId: string | null;

  periodStart: string | null;
  periodEnd: string | null;
  periodStatus: string | null;
  budgeted: number;
  actual: number;
  /** Favourable-positive variance. */
  variance: number;
  /** Null when there is no plan to measure against. */
  variancePercent: number | null;
  favourable: boolean;
  /** Ledger activity with no budget line for that account and period. */
  unbudgeted: boolean;
  status: BudgetVarianceStatus;
}

export interface BudgetVarianceTotals {
  budgeted: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  favourable: boolean;
}

export interface BudgetAccountSummary {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  budgeted: number;
  actual: number;
  variance: number;
  variancePercent: number | null;
  favourable: boolean;
  unbudgeted: boolean;
  status: BudgetVarianceStatus;
}

export interface BudgetMonthPoint {
  month: string;
  fullMonth: string;
  monthNumber: number;
  budgeted: number;
  actual: number;
  variance: number;
}

export interface BudgetVarianceSummary {
  rows: BudgetVarianceRow[];
  /** Revenue plan vs earned. */
  income: BudgetVarianceTotals;
  /** Cost plan vs spent. */
  expense: BudgetVarianceTotals;
  /** Balance-sheet accounts budgeted (rare) — reported separately, never netted into P&L. */
  other: BudgetVarianceTotals;
  /** Planned vs actual result (income − expense). */
  net: BudgetVarianceTotals;
  accountSummaries: BudgetAccountSummary[];
  itemsByMonth: Map<number, BudgetVarianceRow[]>;
  itemsByAccount: Map<string, BudgetVarianceRow[]>;
  incomeByMonth: BudgetMonthPoint[];
  expenseByMonth: BudgetMonthPoint[];
  unbudgetedRows: BudgetVarianceRow[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface VarianceReportRow {
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  period_month: number | null;
  fiscal_period_id: string | null;
  period_start: string | null;
  period_end: string | null;
  period_status: string | null;
  budgeted_amount: number | string | null;
  actual_amount: number | string | null;
  variance_amount: number | string | null;
  variance_percent: number | string | null;
  is_favourable: boolean | null;
  is_unbudgeted: boolean | null;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

function statusOf(variance: number, budgeted: number, actual: number): BudgetVarianceStatus {
  if (budgeted === 0) {
    if (actual === 0) return "on_track";
    return variance >= 0 ? "favourable" : "unfavourable";
  }
  const pct = (variance / Math.abs(budgeted)) * 100;
  if (pct > MATERIALITY_PCT) return "favourable";
  if (pct < -MATERIALITY_PCT) return "unfavourable";
  return "on_track";
}

function totals(rows: BudgetVarianceRow[], creditNormal: boolean): BudgetVarianceTotals {
  const budgeted = rows.reduce((s, r) => s + r.budgeted, 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const variance = creditNormal ? actual - budgeted : budgeted - actual;
  return {
    budgeted,
    actual,
    variance,
    variancePercent: budgeted === 0 ? null : (variance / Math.abs(budgeted)) * 100,
    favourable: variance >= 0,
  };
}

function monthSeries(rows: BudgetVarianceRow[], creditNormal: boolean): BudgetMonthPoint[] {
  return MONTHS.map((month, index) => {
    const monthNumber = index + 1;
    const monthRows = rows.filter((r) => r.month === monthNumber);
    const budgeted = monthRows.reduce((s, r) => s + r.budgeted, 0);
    const actual = monthRows.reduce((s, r) => s + r.actual, 0);
    return {
      month: month.substring(0, 3),
      fullMonth: month,
      monthNumber,
      budgeted,
      actual,
      variance: creditNormal ? actual - budgeted : budgeted - actual,
    };
  });
}

export function useBudgetVsActual(budgetId?: string) {
  const { budgets } = useBudgets();

  const selectedBudget: Budget | undefined = budgets.find((b) => b.id === budgetId);

  const {
    data: rows = [],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ["budget-vs-actual", budgetId],
    queryFn: async (): Promise<BudgetVarianceRow[]> => {
      if (!budgetId) return [];
      const { data, error: rpcError } = await supabase.rpc("get_budget_variance_report", {
        _budget_id: budgetId,
      });
      if (rpcError) throw rpcError;

      return ((data ?? []) as unknown as VarianceReportRow[]).map((r) => {
        const budgeted = num(r.budgeted_amount);
        const actual = num(r.actual_amount);
        const variance = num(r.variance_amount);
        return {
          accountId: r.account_id,
          accountCode: r.account_code ?? "",
          accountName: r.account_name ?? "Unknown account",
          accountType: r.account_type ?? "",
          month: r.period_month ?? 0,
          fiscalPeriodId: r.fiscal_period_id,
          periodStart: r.period_start,
          periodEnd: r.period_end,
          periodStatus: r.period_status,
          budgeted,
          actual,
          variance,
          variancePercent: r.variance_percent === null || r.variance_percent === undefined
            ? null
            : Number(r.variance_percent),
          favourable: r.is_favourable ?? variance >= 0,
          unbudgeted: r.is_unbudgeted ?? false,
          status: statusOf(variance, budgeted, actual),
        };
      });
    },
    enabled: !!budgetId,
  });

  const report = useMemo<BudgetVarianceSummary | null>(() => {
    if (!budgetId) return null;

    const incomeRows = rows.filter((r) => r.accountType === "income");
    const expenseRows = rows.filter((r) => r.accountType === "expense");
    const otherRows = rows.filter((r) => r.accountType !== "income" && r.accountType !== "expense");

    const income = totals(incomeRows, true);
    const expense = totals(expenseRows, false);
    const other = totals(otherRows, false);

    const netBudgeted = income.budgeted - expense.budgeted;
    const netActual = income.actual - expense.actual;
    const netVariance = netActual - netBudgeted;

    const byAccount = new Map<string, BudgetVarianceRow[]>();
    const byMonth = new Map<number, BudgetVarianceRow[]>();
    for (const row of rows) {
      byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
      byMonth.set(row.month, [...(byMonth.get(row.month) ?? []), row]);
    }

    const accountSummaries: BudgetAccountSummary[] = Array.from(byAccount.entries())
      .map(([accountId, accountRows]) => {
        const first = accountRows[0];
        const creditNormal = first.accountType === "income" || first.accountType === "liability" || first.accountType === "equity";
        const t = totals(accountRows, creditNormal);
        return {
          accountId,
          accountCode: first.accountCode,
          accountName: first.accountName,
          accountType: first.accountType,
          budgeted: t.budgeted,
          actual: t.actual,
          variance: t.variance,
          variancePercent: t.variancePercent,
          favourable: t.favourable,
          unbudgeted: accountRows.every((r) => r.unbudgeted),
          status: statusOf(t.variance, t.budgeted, t.actual),
        };
      })
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

    return {
      rows,
      income,
      expense,
      other,
      net: {
        budgeted: netBudgeted,
        actual: netActual,
        variance: netVariance,
        variancePercent: netBudgeted === 0 ? null : (netVariance / Math.abs(netBudgeted)) * 100,
        favourable: netVariance >= 0,
      },
      accountSummaries,
      itemsByMonth: byMonth,
      itemsByAccount: byAccount,
      incomeByMonth: monthSeries(incomeRows, true),
      expenseByMonth: monthSeries(expenseRows, false),
      unbudgetedRows: rows.filter((r) => r.unbudgeted),
    };
  }, [rows, budgetId]);

  return {
    selectedBudget,
    rows,
    report,
    isLoading,
    isFetching,
    error,
    refetch,
    months: MONTHS,
  };
}
