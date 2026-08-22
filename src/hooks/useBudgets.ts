import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { financeKey } from "@/lib/finance/financeKey";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type BudgetStatus = 'draft' | 'active' | 'closed';

export interface Budget {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  name: string;
  fiscal_year: number;
  currency_code: string | null;
  description: string | null;
  status: BudgetStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items?: BudgetItem[];
  total_budgeted?: number;
}

export interface BudgetItem {
  id: string;
  budget_id: string;
  business_id: string | null;
  account_id: string;
  /** Derived server-side from the linked fiscal period — display only. */
  period_month: number;
  /** Authoritative accounting period this line belongs to. */
  fiscal_period_id: string | null;
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

export interface BudgetLineInput {
  account_id: string;
  period_month: number;
  budgeted_amount: number;
  notes?: string;
}

export interface CreateBudgetInput {
  name: string;
  fiscal_year: number;
  description?: string;
  items?: BudgetLineInput[];
}

const lineKey = (accountId: string, periodMonth: number) => `${accountId}|${periodMonth}`;


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

  // Budgets are scoped data: every mutation must invalidate the scoped finance
  // keys, not the bare ["budgets"] prefix (which no query actually uses).
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: financeKey(scope, "budgets") });
    queryClient.invalidateQueries({ queryKey: ["finance"] });
    queryClient.invalidateQueries({ queryKey: ["budget-vs-actual"] });
  };

  // Create budget (always starts as a draft — activation is a separate action)
  const createBudget = useMutation({
    mutationFn: async (input: CreateBudgetInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("Select a company before creating a budget");

      const { data: userData } = await supabase.auth.getUser();

      const { data: budget, error: budgetError } = await supabase
        .from("budgets")
        .insert({
          organization_id: organizationId,
          business_id: currentBusiness.id,
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

      if (input.items && input.items.length > 0) {
        const { error: itemsError } = await supabase.from("budget_items").insert(
          input.items.map(item => ({
            budget_id: budget.id,
            account_id: item.account_id,
            period_month: item.period_month,
            budgeted_amount: item.budgeted_amount,
            notes: item.notes,
          })),
        );
        if (itemsError) throw itemsError;
      }

      return budget;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget created");
    },
    onError: (error) => {
      toast.error("Failed to create budget: " + normalizeError(error).message);
    },
  });

  /**
   * Update a DRAFT budget non-destructively.
   *
   * The previous implementation deleted every line and re-inserted it, which
   * churned primary keys that revisions and reports reference. We now diff on
   * (account_id, period_month): update changed amounts, insert new lines, and
   * delete only lines the user actually removed.
   * Active budgets are rejected by the database — use applyRevision instead.
   */
  const updateBudget = useMutation({
    mutationFn: async ({ id, ...input }: CreateBudgetInput & { id: string }) => {
      const { error: budgetError } = await supabase
        .from("budgets")
        .update({
          name: input.name,
          fiscal_year: input.fiscal_year,
          description: input.description,
        })
        .eq("id", id);

      if (budgetError) throw budgetError;

      if (!input.items) return;

      const { data: existing, error: existingError } = await supabase
        .from("budget_items")
        .select("id, account_id, period_month, budgeted_amount, notes")
        .eq("budget_id", id);

      if (existingError) throw existingError;

      const existingByKey = new Map(
        (existing ?? []).map(row => [lineKey(row.account_id, row.period_month), row]),
      );
      const desiredKeys = new Set<string>();

      const toInsert: Array<Record<string, unknown>> = [];
      const toUpdate: Array<{ id: string; budgeted_amount: number; notes?: string | null }> = [];

      for (const item of input.items) {
        const key = lineKey(item.account_id, item.period_month);
        desiredKeys.add(key);
        const current = existingByKey.get(key);
        if (!current) {
          toInsert.push({
            budget_id: id,
            account_id: item.account_id,
            period_month: item.period_month,
            budgeted_amount: item.budgeted_amount,
            notes: item.notes ?? null,
          });
        } else if (
          Number(current.budgeted_amount) !== Number(item.budgeted_amount) ||
          (current.notes ?? null) !== (item.notes ?? null)
        ) {
          toUpdate.push({
            id: current.id,
            budgeted_amount: item.budgeted_amount,
            notes: item.notes ?? null,
          });
        }
      }

      const removedIds = (existing ?? [])
        .filter(row => !desiredKeys.has(lineKey(row.account_id, row.period_month)))
        .map(row => row.id);

      if (toInsert.length > 0) {
        const { error } = await supabase.from("budget_items").insert(toInsert as never);
        if (error) throw error;
      }
      for (const row of toUpdate) {
        const { error } = await supabase
          .from("budget_items")
          .update({ budgeted_amount: row.budgeted_amount, notes: row.notes })
          .eq("id", row.id);
        if (error) throw error;
      }
      if (removedIds.length > 0) {
        const { error } = await supabase.from("budget_items").delete().in("id", removedIds);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget updated");
    },
    onError: (error) => {
      toast.error("Failed to update budget: " + normalizeError(error).message);
    },
  });

  // Activate budget — permission + transition enforced server-side
  const activateBudget = useMutation({
    mutationFn: async (budgetId: string) => {
      const { error } = await supabase.rpc("set_budget_status", {
        _budget_id: budgetId,
        _status: "active",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget activated");
    },
    onError: (error) => {
      toast.error("Failed to activate budget: " + normalizeError(error).message);
    },
  });

  // Close budget — terminal state, no reopening
  const closeBudget = useMutation({
    mutationFn: async (budgetId: string) => {
      const { error } = await supabase.rpc("set_budget_status", {
        _budget_id: budgetId,
        _status: "closed",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget closed");
    },
    onError: (error) => {
      toast.error("Failed to close budget: " + normalizeError(error).message);
    },
  });

  /**
   * Change an ACTIVE budget through a recorded revision. Previous and new
   * amounts are stored per line so variance history stays explainable.
   */
  const applyRevision = useMutation({
    mutationFn: async ({
      budgetId,
      reason,
      note,
      lines,
    }: {
      budgetId: string;
      reason: string;
      note?: string;
      lines: Array<{ account_id: string; period_month: number; budgeted_amount: number }>;
    }) => {
      const { data, error } = await supabase.rpc("apply_budget_revision", {
        _budget_id: budgetId,
        _reason: reason,
        _lines: lines as never,
        _note: note ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget revision recorded");
    },
    onError: (error) => {
      toast.error("Failed to record revision: " + normalizeError(error).message);
    },
  });

  // Delete budget — the database allows this for drafts only
  const deleteBudget = useMutation({
    mutationFn: async (budgetId: string) => {
      const { error: itemsError } = await supabase
        .from("budget_items")
        .delete()
        .eq("budget_id", budgetId);
      if (itemsError) throw itemsError;

      const { error } = await supabase.from("budgets").delete().eq("id", budgetId);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete budget: " + normalizeError(error).message);
    },
  });

  // Add/Update a single budget line (draft budgets only)
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
      invalidate();
    },
    onError: (error) => {
      toast.error("Failed to update budget item: " + normalizeError(error).message);
    },
  });

  // Delete a single budget line (draft budgets only)
  const deleteBudgetItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from("budget_items")
        .delete()
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
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
    applyRevision,
    deleteBudget,
    upsertBudgetItem,
    deleteBudgetItem,
  };
}

