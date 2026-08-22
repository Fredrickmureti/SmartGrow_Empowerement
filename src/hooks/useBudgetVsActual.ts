import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBudgets, Budget, BudgetItem } from "./useBudgets";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface BudgetActual {
  id: string;
  organization_id: string;
  budget_id: string;
  account_id: string;
  period_month: number;
  fiscal_period_id: string | null;
  fiscal_year: number;
  actual_amount: number;
  calculated_at: string;
}

export interface BudgetVarianceItem {
  accountId: string;
  accountCode: string;
  accountName: string;
  month: number;
  budgeted: number;
  actual: number;
  variance: number;
  variancePercent: number;
  status: "under" | "over" | "on_track";
}

export interface BudgetVarianceSummary {
  totalBudgeted: number;
  totalActual: number;
  totalVariance: number;
  variancePercent: number;
  itemsByMonth: Map<number, BudgetVarianceItem[]>;
  itemsByAccount: Map<string, BudgetVarianceItem[]>;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function useBudgetVsActual(budgetId?: string) {
  const { currentOrg } = useOrganization();
  const { budgets } = useBudgets();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;

  // Get the selected budget
  const selectedBudget = budgets.find((b) => b.id === budgetId);

  // Fetch stored actuals
  const { data: storedActuals = [], isLoading: actualsLoading } = useQuery({
    queryKey: ["budget-actuals", organizationId, budgetId],
    queryFn: async () => {
      if (!organizationId || !budgetId) return [];
      const { data, error } = await supabase
        // SCOPE-EXEMPT: budget_actuals filtered by budget_id (PK) which is itself business-scoped
        .from("budget_actuals")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("budget_id", budgetId);
      if (error) throw error;
      return data as BudgetActual[];
    },
    enabled: !!organizationId && !!budgetId,
  });

  /**
   * Recompute actuals from the general ledger.
   *
   * The computation lives in the database (recalculate_budget_actuals):
   * only posted, non-closing, non-opening, non-sample entries count; dates are
   * matched to the business's own monthly fiscal periods; branch-scoped
   * budgets only see their own branch; and there is no 1,000-row client
   * fetch limit to silently truncate large accounts.
   */
  const calculateActuals = useMutation({
    mutationFn: async (budget: Budget) => {
      const { data, error } = await supabase.rpc("recalculate_budget_actuals", {
        _budget_id: budget.id,
      });
      if (error) throw error;
      return data ?? [];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budget-actuals"] });
      queryClient.invalidateQueries({ queryKey: ["budget-vs-actual"] });
      toast.success("Actuals recalculated from the ledger");
    },
    onError: (error) => {
      toast.error("Failed to calculate actuals: " + normalizeError(error).message);
    },
  });


  // Generate variance report
  const getVarianceReport = (budget: Budget): BudgetVarianceSummary | null => {
    if (!budget.items) return null;

    const items = budget.items;
    const varianceItems: BudgetVarianceItem[] = [];
    let totalBudgeted = 0;
    let totalActual = 0;

    for (const item of items) {
      const actual = storedActuals.find(
        (a) => a.account_id === item.account_id && a.period_month === item.period_month
      );
      
      const budgeted = item.budgeted_amount;
      const actualAmount = actual?.actual_amount || 0;
      const variance = budgeted - actualAmount;
      const variancePercent = budgeted > 0 ? (variance / budgeted) * 100 : 0;

      totalBudgeted += budgeted;
      totalActual += actualAmount;

      let status: "under" | "over" | "on_track" = "on_track";
      if (variancePercent < -10) status = "over";
      else if (variancePercent > 10) status = "under";

      varianceItems.push({
        accountId: item.account_id,
        accountCode: item.accounts?.code || "",
        accountName: item.accounts?.name || "Unknown",
        month: item.period_month,
        budgeted,
        actual: actualAmount,
        variance,
        variancePercent,
        status,
      });
    }

    // Group by month
    const itemsByMonth = new Map<number, BudgetVarianceItem[]>();
    for (const item of varianceItems) {
      const existing = itemsByMonth.get(item.month) || [];
      existing.push(item);
      itemsByMonth.set(item.month, existing);
    }

    // Group by account
    const itemsByAccount = new Map<string, BudgetVarianceItem[]>();
    for (const item of varianceItems) {
      const existing = itemsByAccount.get(item.accountId) || [];
      existing.push(item);
      itemsByAccount.set(item.accountId, existing);
    }

    const totalVariance = totalBudgeted - totalActual;
    const variancePercent = totalBudgeted > 0 ? (totalVariance / totalBudgeted) * 100 : 0;

    return {
      totalBudgeted,
      totalActual,
      totalVariance,
      variancePercent,
      itemsByMonth,
      itemsByAccount,
    };
  };

  // Get chart data for visualization
  const getChartData = (budget: Budget) => {
    const items = budget.items || [];
    
    return MONTHS.map((month, index) => {
      const monthNum = index + 1;
      const monthItems = items.filter((i) => i.period_month === monthNum);
      const monthActuals = storedActuals.filter((a) => a.period_month === monthNum);
      
      const budgeted = monthItems.reduce((sum, i) => sum + i.budgeted_amount, 0);
      const actual = monthActuals.reduce((sum, a) => sum + a.actual_amount, 0);
      
      return {
        month: month.substring(0, 3),
        fullMonth: month,
        budgeted,
        actual,
        variance: budgeted - actual,
      };
    });
  };

  return {
    selectedBudget,
    storedActuals,
    isLoading: actualsLoading,
    calculateActuals,
    getVarianceReport,
    getChartData,
    months: MONTHS,
  };
}
