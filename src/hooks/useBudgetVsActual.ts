import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBudgets, Budget, BudgetItem } from "./useBudgets";
import { toast } from "sonner";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { normalizeError } from "@/services/resilience";

export interface BudgetActual {
  id: string;
  organization_id: string;
  budget_id: string;
  account_id: string;
  period_month: number;
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

  // Calculate actuals from journal entries
  const calculateActuals = useMutation({
    mutationFn: async (budget: Budget) => {
      if (!organizationId) throw new Error("No organization selected");

      const fiscalYear = budget.fiscal_year;
      const accountIds = [...new Set(budget.items?.map((i) => i.account_id) || [])];
      
      if (accountIds.length === 0) return [];

      // Get all journal entry lines for these accounts in this fiscal year.
      // If the budget is scoped to a specific branch, scope the JE lines too —
      // a Branch A budget must measure against Branch A actuals, never HQ
      // or sibling-branch GL activity. (Budgets with NULL branch_id are
      // treated as company-wide and use all branches.)
      const budgetBranchId = (budget as any).branch_id ?? null;
      let jeLinesQ = supabase
        .from("journal_entry_lines")
        .select(`
          account_id,
          debit,
          credit,
          journal_entry:journal_entries!inner(
            entry_date,
            status,
            branch_id
          )
        `)
        .in("account_id", accountIds);
      if (budgetBranchId) {
        jeLinesQ = jeLinesQ.eq("journal_entry.branch_id", budgetBranchId);
      }
      const [{ data: journalLines, error: journalError }, { data: accountData, error: accountError }] = await Promise.all([
        jeLinesQ,
        supabase
          .from("accounts")
          .select("id, account_type")
          .in("id", accountIds),
      ]);

      if (journalError) throw journalError;
      if (accountError) throw accountError;

      // Build account type lookup
      const accountTypeMap = new Map<string, string>();
      for (const acc of accountData || []) {
        accountTypeMap.set(acc.id, acc.account_type);
      }

      // Filter to fiscal year and calculate monthly totals
      const monthlyActuals: Map<string, number> = new Map();

      for (const line of journalLines || []) {
        const entry = line.journal_entry as { entry_date: string; status: string } | null;
        if (!entry || entry.status !== "posted") continue;

        const entryDate = new Date(entry.entry_date);
        if (entryDate.getFullYear() !== fiscalYear) continue;

        const month = entryDate.getMonth() + 1;
        const key = `${line.account_id}-${month}`;
        
        // Use account-type-aware calculation:
        // Expense accounts: debit - credit (positive = spending)
        // Income accounts: credit - debit (positive = revenue)
        // Assets/Liabilities/Equity: debit - credit (standard)
        const accountType = accountTypeMap.get(line.account_id) || "expense";
        const isDebitNormal = ["asset", "expense"].includes(accountType);
        const amount = isDebitNormal
          ? (line.debit || 0) - (line.credit || 0)
          : (line.credit || 0) - (line.debit || 0);
        
        monthlyActuals.set(key, (monthlyActuals.get(key) || 0) + amount);
      }

      // Upsert actuals - amounts are now correctly signed (positive = normal activity)
      // budget_actuals.business_id is NOT NULL — inherit from the parent budget.
      const budgetBusinessId = (budget as any).business_id;
      if (!budgetBusinessId) {
        throw new Error("Budget is missing business_id — cannot compute actuals");
      }
      const actualsToInsert = Array.from(monthlyActuals.entries()).map(([key, amount]) => {
        const [accountId, month] = key.split("-");
        return {
          organization_id: organizationId,
          business_id: budgetBusinessId,
          budget_id: budget.id,
          account_id: accountId,
          period_month: parseInt(month),
          fiscal_year: fiscalYear,
          actual_amount: amount,
          calculated_at: new Date().toISOString(),
        };
      });

      if (actualsToInsert.length > 0) {
        // Delete existing actuals for this budget
        await supabase
          .from("budget_actuals")
          .delete()
          .eq("budget_id", budget.id);

        const { error } = await supabase
          .from("budget_actuals")
          .insert(actualsToInsert);
        if (error) throw error;
      }

      return actualsToInsert;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budget-actuals"] });
      toast.success("Actuals calculated successfully");
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
