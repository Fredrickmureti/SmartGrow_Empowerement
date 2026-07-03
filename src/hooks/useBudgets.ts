import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { financeKey } from "@/lib/finance/financeKey";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface Budget {
  id: string;
  organization_id: string;
  name: string;
  fiscal_year: number;
  description: string | null;
  status: 'draft' | 'active' | 'closed';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items?: BudgetItem[];
  total_budgeted?: number;
}

export interface BudgetItem {
  id: string;
  budget_id: string;
  account_id: string;
  period_month: number;
  budgeted_amount: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  accounts?: {
    id: string;
    name: string;
    code: string;
    account_type: string;
  };
}

export interface CreateBudgetInput {
  name: string;
  fiscal_year: number;
  description?: string;
  items?: {
    account_id: string;
    period_month: number;
    budgeted_amount: number;
    notes?: string;
  }[];
}

export function useBudgets() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;

  // Fetch budgets — keyed on full finance scope so a branch switch invalidates
  const { data: budgets = [], isLoading } = useQuery({
    queryKey: financeKey(scope, "budgets"),
    queryFn: async () => {
      if (!organizationId) return [];
      let query = supabase
        .from("budgets")
        .select(`
          *,
          budget_items(
            *,
            accounts(id, name, code, account_type)
          )
        `)
        .eq("organization_id", organizationId);

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }
      // Branch scoping: in branch view show this branch + business-wide budgets;
      // in consolidated view show every branch under the business.
      if (scope.branchId) {
        query = query.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      }

      const { data, error } = await query.order("fiscal_year", { ascending: false });

      if (error) throw error;
      
      return data.map(budget => ({
        ...budget,
        items: budget.budget_items,
        total_budgeted: budget.budget_items?.reduce(
          (sum: number, item: BudgetItem) => sum + (item.budgeted_amount || 0), 
          0
        ) || 0,
      })) as Budget[];
    },
    enabled: !!organizationId,
  });

  // Create budget
  const createBudget = useMutation({
    mutationFn: async (input: CreateBudgetInput) => {
      if (!organizationId) throw new Error("No organization selected");

      const { data: userData } = await supabase.auth.getUser();

      // Create budget — stamp business_id (NOT NULL) and branch_id from active scope
      const { data: budget, error: budgetError } = await supabase
        .from("budgets")
        .insert({
          organization_id: organizationId,
          business_id: currentBusiness?.id || null,
          branch_id: scope.branchId,
          name: input.name,
          fiscal_year: input.fiscal_year,
          description: input.description,
          status: "draft",
          created_by: userData?.user?.id,
        })
        .select()
        .single();

      if (budgetError) throw budgetError;

      // Create budget items if provided
      if (input.items && input.items.length > 0) {
        const items = input.items.map(item => ({
          budget_id: budget.id,
          account_id: item.account_id,
          period_month: item.period_month,
          budgeted_amount: item.budgeted_amount,
          notes: item.notes,
        }));

        const { error: itemsError } = await supabase
          .from("budget_items")
          .insert(items);

        if (itemsError) throw itemsError;
      }

      return budget;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      toast.success("Budget created");
    },
    onError: (error) => {
      toast.error("Failed to create budget: " + normalizeError(error).message);
    },
  });

  // Update budget
  const updateBudget = useMutation({
    mutationFn: async ({ id, ...input }: CreateBudgetInput & { id: string }) => {
      // Update budget
      const { error: budgetError } = await supabase
        .from("budgets")
        .update({
          name: input.name,
          fiscal_year: input.fiscal_year,
          description: input.description,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (budgetError) throw budgetError;

      // If items provided, replace all items
      if (input.items) {
        // Delete existing items
        await supabase
          .from("budget_items")
          .delete()
          .eq("budget_id", id);

        // Insert new items
        if (input.items.length > 0) {
          const items = input.items.map(item => ({
            budget_id: id,
            account_id: item.account_id,
            period_month: item.period_month,
            budgeted_amount: item.budgeted_amount,
            notes: item.notes,
          }));

          const { error: itemsError } = await supabase
            .from("budget_items")
            .insert(items);

          if (itemsError) throw itemsError;
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      toast.success("Budget updated");
    },
    onError: (error) => {
      toast.error("Failed to update budget: " + normalizeError(error).message);
    },
  });

  // Activate budget
  const activateBudget = useMutation({
    mutationFn: async (budgetId: string) => {
      const { error } = await supabase
        .from("budgets")
        .update({ status: "active" })
        .eq("id", budgetId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      toast.success("Budget activated");
    },
    onError: (error) => {
      toast.error("Failed to activate budget: " + normalizeError(error).message);
    },
  });

  // Close budget
  const closeBudget = useMutation({
    mutationFn: async (budgetId: string) => {
      const { error } = await supabase
        .from("budgets")
        .update({ status: "closed" })
        .eq("id", budgetId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      toast.success("Budget closed");
    },
    onError: (error) => {
      toast.error("Failed to close budget: " + normalizeError(error).message);
    },
  });

  // Delete budget
  const deleteBudget = useMutation({
    mutationFn: async (budgetId: string) => {
      // Delete items first
      await supabase
        .from("budget_items")
        .delete()
        .eq("budget_id", budgetId);

      // Delete budget
      const { error } = await supabase
        .from("budgets")
        .delete()
        .eq("id", budgetId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      toast.success("Budget deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete budget: " + normalizeError(error).message);
    },
  });

  // Add/Update budget item
  const upsertBudgetItem = useMutation({
    mutationFn: async (item: {
      budget_id: string;
      account_id: string;
      period_month: number;
      budgeted_amount: number;
      notes?: string;
    }) => {
      const { error } = await supabase
        .from("budget_items")
        .upsert(item, {
          onConflict: "budget_id,account_id,period_month",
        });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
    onError: (error) => {
      toast.error("Failed to update budget item: " + normalizeError(error).message);
    },
  });

  // Delete budget item — required by the inline items grid on
  // BudgetEditPage. The legacy BudgetItemSheet flow only supported
  // upsert; row-level delete is a new affordance of the routed page.
  const deleteBudgetItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from("budget_items")
        .delete()
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
    onError: (error) => {
      toast.error("Failed to delete budget item: " + normalizeError(error).message);
    },
  });

  return {
    budgets,
    isLoading,
    createBudget,
    updateBudget,
    activateBudget,
    closeBudget,
    deleteBudget,
    upsertBudgetItem,
    deleteBudgetItem,
  };
}
