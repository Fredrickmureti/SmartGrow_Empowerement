import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAccounts, Account } from "./useAccounts";
import { useFiscalPeriods } from "./useFiscalPeriods";
import { useGLPosting, GLEntry } from "./useGLPosting";
import { toast } from "sonner";
import { useState, useCallback } from "react";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

export interface YearEndClosingResult {
  closingEntryId: string;
  incomeTotal: number;
  expenseTotal: number;
  netIncomeOrLoss: number;
  retainedEarningsAccountId: string;
}

export interface YearEndClosingInput {
  fiscalYear: number;
  closingDate: string;
  retainedEarningsAccountId: string;
  notes?: string;
}

/**
 * Year-end closing hook — routes through useGLPosting for:
 * - Fiscal period lock enforcement
 * - Permission checks
 * - Atomic DB transaction
 * - Idempotency
 *
 * Preview and closing BOTH use GL-derived values from get_account_movements RPC.
 * Uses fiscal_year_start from organization settings for correct date boundaries.
 */
export function useYearEndClosing() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { accounts, refreshAccounts } = useAccounts();
  const { periods, closePeriod, getFiscalYearBounds } = useFiscalPeriods();
  const { postToGL } = useGLPosting();
  const queryClient = useQueryClient();
  const [previewData, setPreviewData] = useState<{
    totalIncome: number;
    totalExpenses: number;
    netIncomeOrLoss: number;
    incomeAccountsCount: number;
    expenseAccountsCount: number;
    isProfit: boolean;
  } | null>(null);

  const getIncomeAccounts = (): Account[] =>
    accounts.filter(a => a.account_type === "income");

  const getExpenseAccounts = (): Account[] =>
    accounts.filter(a => a.account_type === "expense");

  const getRetainedEarningsAccounts = (): Account[] =>
    accounts.filter(a => a.account_type === "equity" && (a.name.toLowerCase().includes("retained") || a.name.toLowerCase().includes("earnings")));

  /**
   * Fetches GL-derived balances for income/expense accounts for a fiscal year.
   * Uses fiscal_year_start to determine correct date boundaries.
   */
  const fetchGLBalances = async (fiscalYear: number): Promise<Map<string, { debit: number; credit: number }>> => {
    if (!currentOrg) return new Map();

    const bounds = await getFiscalYearBounds(fiscalYear);
    const dateFrom = format(bounds.startDate, "yyyy-MM-dd");
    const dateTo = format(bounds.endDate, "yyyy-MM-dd");

    const { data, error } = await supabase.rpc("get_account_movements", {
      _org_id: currentOrg.id,
      _date_from: dateFrom,
      _date_to: dateTo,
      _business_id: currentBusiness?.id || null,
    });

    if (error) throw new Error(`Failed to fetch GL movements: ${error.message}`);

    const map = new Map<string, { debit: number; credit: number }>();
    for (const row of data || []) {
      map.set(row.account_id, { debit: row.total_debit, credit: row.total_credit });
    }
    return map;
  };

  /**
   * GL-derived closing totals preview — uses get_account_movements RPC
   * instead of stale current_balance on accounts table.
   */
  const calculateClosingTotals = useCallback(async (fiscalYear: number) => {
    if (!currentOrg) {
      return { totalIncome: 0, totalExpenses: 0, netIncomeOrLoss: 0, incomeAccountsCount: 0, expenseAccountsCount: 0, isProfit: true };
    }

    const glBalances = await fetchGLBalances(fiscalYear);
    const incomeAccounts = getIncomeAccounts();
    const expenseAccounts = getExpenseAccounts();

    let totalIncome = 0;
    let incomeCount = 0;
    for (const account of incomeAccounts) {
      const mov = glBalances.get(account.id);
      if (!mov) continue;
      const balance = mov.credit - mov.debit;
      if (Math.abs(balance) > 0.001) {
        totalIncome += Math.abs(balance);
        incomeCount++;
      }
    }

    let totalExpenses = 0;
    let expenseCount = 0;
    for (const account of expenseAccounts) {
      const mov = glBalances.get(account.id);
      if (!mov) continue;
      const balance = mov.debit - mov.credit;
      if (Math.abs(balance) > 0.001) {
        totalExpenses += Math.abs(balance);
        expenseCount++;
      }
    }

    const netIncomeOrLoss = totalIncome - totalExpenses;
    const result = {
      totalIncome,
      totalExpenses,
      netIncomeOrLoss,
      incomeAccountsCount: incomeCount,
      expenseAccountsCount: expenseCount,
      isProfit: netIncomeOrLoss >= 0,
    };
    setPreviewData(result);
    return result;
  }, [currentOrg, currentBusiness, accounts]);

  /**
   * Quick synchronous preview using cached data (for initial render before async completes)
   */
  const getQuickPreview = () => {
    if (previewData) return previewData;
    // Fallback to account current_balance (will be replaced by async call)
    const incomeAccounts = getIncomeAccounts();
    const expenseAccounts = getExpenseAccounts();
    const totalIncome = incomeAccounts.reduce((sum, a) => sum + Math.abs(a.current_balance ?? 0), 0);
    const totalExpenses = expenseAccounts.reduce((sum, a) => sum + Math.abs(a.current_balance ?? 0), 0);
    const netIncomeOrLoss = totalIncome - totalExpenses;
    return {
      totalIncome,
      totalExpenses,
      netIncomeOrLoss,
      incomeAccountsCount: incomeAccounts.length,
      expenseAccountsCount: expenseAccounts.length,
      isProfit: netIncomeOrLoss >= 0,
    };
  };

  const getFiscalYearPeriod = (year: number) =>
    periods.find(p => p.period_type === "year" && p.name.includes(year.toString()));

  const performYearEndClosing = useMutation({
    mutationFn: async (input: YearEndClosingInput): Promise<YearEndClosingResult> => {
      if (!currentOrg?.id) throw new Error("No organization selected");

      await refreshAccounts();

      const glBalances = await fetchGLBalances(input.fiscalYear);

      const incomeAccounts = getIncomeAccounts();
      const expenseAccounts = getExpenseAccounts();

      let totalIncome = 0;
      const activeIncomeAccounts: Array<{ account: Account; balance: number }> = [];
      for (const account of incomeAccounts) {
        const mov = glBalances.get(account.id);
        if (!mov) continue;
        const balance = mov.credit - mov.debit;
        if (balance === 0) continue;
        totalIncome += Math.abs(balance);
        activeIncomeAccounts.push({ account, balance: Math.abs(balance) });
      }

      let totalExpenses = 0;
      const activeExpenseAccounts: Array<{ account: Account; balance: number }> = [];
      for (const account of expenseAccounts) {
        const mov = glBalances.get(account.id);
        if (!mov) continue;
        const balance = mov.debit - mov.credit;
        if (balance === 0) continue;
        totalExpenses += Math.abs(balance);
        activeExpenseAccounts.push({ account, balance: Math.abs(balance) });
      }

      const netIncomeOrLoss = totalIncome - totalExpenses;

      if (activeIncomeAccounts.length === 0 && activeExpenseAccounts.length === 0) {
        throw new Error("No income or expense accounts with GL movements to close for this fiscal year");
      }

      const entries: GLEntry[] = [];

      for (const { account, balance } of activeIncomeAccounts) {
        entries.push({
          account_id: account.id,
          debit_amount: balance,
          credit_amount: 0,
          description: `Close ${account.name} to Retained Earnings`,
        });
      }

      for (const { account, balance } of activeExpenseAccounts) {
        entries.push({
          account_id: account.id,
          debit_amount: 0,
          credit_amount: balance,
          description: `Close ${account.name} to Retained Earnings`,
        });
      }

      entries.push({
        account_id: input.retainedEarningsAccountId,
        debit_amount: netIncomeOrLoss < 0 ? Math.abs(netIncomeOrLoss) : 0,
        credit_amount: netIncomeOrLoss >= 0 ? netIncomeOrLoss : 0,
        description: netIncomeOrLoss >= 0
          ? `Transfer net income for FY ${input.fiscalYear}`
          : `Transfer net loss for FY ${input.fiscalYear}`,
      });

      // Use the fiscal year period's UUID as source_id so re-running for the same year
      // is idempotent at the DB level via the unique index.
      const fiscalYearPeriodForSource = getFiscalYearPeriod(input.fiscalYear);
      const yeSourceId = fiscalYearPeriodForSource?.id || crypto.randomUUID();

      const jeId = await postToGL({
        source_type: "year_end_closing",
        source_id: yeSourceId,
        reference: `YE-CLOSE-${input.fiscalYear}`,
        memo: `Year-End Closing Entry for Fiscal Year ${input.fiscalYear}`,
        entry_date: input.closingDate,
        entries,
        is_closing: true,
      });

      if (!jeId) throw new Error("Failed to post year-end closing entry to GL");

      const fiscalYearPeriod = getFiscalYearPeriod(input.fiscalYear);
      if (fiscalYearPeriod) {
        await closePeriod.mutateAsync({ periodId: fiscalYearPeriod.id, notes: input.notes });
      }

      // Close all monthly periods within this fiscal year
      const bounds = await getFiscalYearBounds(input.fiscalYear);
      const fyStartStr = format(bounds.startDate, "yyyy-MM-dd");
      const fyEndStr = format(bounds.endDate, "yyyy-MM-dd");

      const yearlyMonthlyPeriods = periods.filter(p =>
        p.period_type === "month" &&
        p.status === "open" &&
        p.start_date >= fyStartStr &&
        p.end_date <= fyEndStr
      );

      for (const period of yearlyMonthlyPeriods) {
        await closePeriod.mutateAsync({
          periodId: period.id,
          notes: `Closed as part of FY ${input.fiscalYear} year-end closing`,
        });
      }

      return {
        closingEntryId: jeId,
        incomeTotal: totalIncome,
        expenseTotal: totalExpenses,
        netIncomeOrLoss,
        retainedEarningsAccountId: input.retainedEarningsAccountId,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      queryClient.invalidateQueries({ queryKey: ["fiscal-periods"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });

      const message = result.netIncomeOrLoss >= 0
        ? `Year-end closing complete. Net Income of ${result.netIncomeOrLoss.toLocaleString()} transferred to Retained Earnings.`
        : `Year-end closing complete. Net Loss of ${Math.abs(result.netIncomeOrLoss).toLocaleString()} recorded in Retained Earnings.`;

      toast.success(message);
    },
    onError: (error) => {
      toast.error(`Year-end closing failed: ${normalizeError(error).message}`);
    },
  });

  return {
    incomeAccounts: getIncomeAccounts(),
    expenseAccounts: getExpenseAccounts(),
    retainedEarningsAccounts: getRetainedEarningsAccounts(),
    calculateClosingTotals,
    getQuickPreview,
    getFiscalYearPeriod,
    performYearEndClosing,
    isClosing: performYearEndClosing.isPending,
  };
}
