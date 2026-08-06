import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { postExpenseGL } from "@/lib/finance/expenseSettlement";
import { triggerAutomation } from "@/lib/automations/triggerAutomation";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import { dispatchApprovalNotification } from "@/lib/hr/approvalNotifications";

export interface ExpenseCategory {
  id: string;
  organization_id: string;
  business_id?: string | null;
  name: string;
  description: string | null;
  color: string;
  is_active: boolean;
  account_id: string | null;
  created_at: string;
}

export interface Expense {
  id: string;
  organization_id: string;
  category_id: string | null;
  vendor_id: string | null;
  account_id: string | null;
  payment_account_id: string | null;
  expense_date: string;
  amount: number;
  tax_amount: number;
  currency: string;
  description: string;
  reference: string | null;
  receipt_url: string | null;
  status: "pending" | "approved" | "rejected" | "paid";
  payment_method: string;
  is_billable: boolean;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  category?: ExpenseCategory | null;
  vendor?: { name: string } | null;
}

export function useExpenses() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchExpenses = async () => {
    if (!currentOrg || !currentBusiness) {
      setExpenses([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let q = supabase
        .from("expenses")
        .select(`
          *,
          category:expense_categories(*),
          vendor:contacts(name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("expense_date", { ascending: false });
      // Branch isolation — matches active branch OR legacy NULL.
      q = applyBranchFilter(q, currentBranch?.id ?? null);
      const { data, error } = await q;

      if (error) throw error;
      setExpenses(data as Expense[]);
    } catch (error: any) {
      console.error("Error fetching expenses:", error);
      toast({
        title: "Error loading expenses",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchCategories = async () => {
    if (!currentOrg) return;

    try {
      let query = supabase
        .from("expense_categories")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("name");

      // Business-scope: show categories for this business OR org-wide (null business_id)
      if (currentBusiness?.id) {
        query = query.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      }

      const { data, error } = await query;

      if (error) throw error;
      setCategories(data as ExpenseCategory[]);
    } catch (error: any) {
      console.error("Error fetching categories:", error);
    }
  };

  useEffect(() => {
    fetchExpenses();
    fetchCategories();
  }, [currentOrg?.id, currentBusiness?.id]);

  // GL posting for expenses is server-side only — see
  // `@/lib/finance/expenseSettlement` and `public.post_expense_gl` (ADR 0123).

  const createExpense = async (expense: Omit<Expense, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "category" | "vendor">) => {
    if (!can("manageFinancials")) throw new Error("Permission denied: cannot create expenses");
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const insertData = {
      ...expense,
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      // Stamp branch from active context — prevents NULL-branch leak.
      branch_id: (expense as any).branch_id ?? currentBranch?.id ?? null,
      created_by: user.id,
    };

    const { data, error } = await supabase
      .from("expenses")
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    // Log creation
    logAction({
      action: "created",
      entityType: "expense",
      entityId: data.id,
      entityName: expense.description,
      changesSummary: `Created expense: ${expense.description} for ${expense.amount}`,
    });

    // Post to GL if expense is approved or paid on creation
    if (expense.status === "approved" || expense.status === "paid") {
      await postExpenseGL(data.id);
    }

    // Optimistic update
    setExpenses((prev) => [data as Expense, ...prev]);

    // Trigger automations (fire-and-forget)
    triggerAutomation({
      event_type: "on_create",
      target_model: "expense",
      record_id: data.id,
      record_data: data,
      organization_id: currentOrg.id,
    });

    return data;
  };

  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    const expense = expenses.find((e) => e.id === id);
    
    // Optimistic update
    setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, ...updates } : e)));

    try {
      // Strip joined fields
      const { category, vendor, ...dbUpdates } = updates as any;

      const { error } = await supabase
        .from("expenses")
        .update(dbUpdates)
        .eq("id", id);

      if (error) throw error;

      // Post to GL on status transition to approved/paid
      const statusChanged = updates.status && expense && updates.status !== expense.status;
      const shouldPostGL = statusChanged && (updates.status === "approved" || updates.status === "paid");
      
      if (shouldPostGL && expense) {
        await postExpenseGL(expense.id);
      }

      // Log update
      if (expense) {
        logAction({
          action: "updated",
          entityType: "expense",
          entityId: id,
          entityName: expense.description,
          changesSummary: `Updated expense: ${expense.description}`,
        });
      }

      // Approval/rejection notification (non-blocking).
      if (
        statusChanged &&
        currentOrg?.id &&
        (updates.status === "approved" || updates.status === "rejected" || updates.status === "paid")
      ) {
        const event =
          updates.status === "rejected" ? "rejected" : "approved";
        void dispatchApprovalNotification({
          organizationId: currentOrg.id,
          entityType: "expense",
          entityId: id,
          event,
          actorUserId: user?.id ?? null,
        });
      }
    } catch (error) {
      // Rollback on error
      if (expense) {
        setExpenses((prev) => prev.map((e) => (e.id === id ? expense : e)));
      }
      throw error;
    }
  };

  const deleteExpense = async (id: string) => {
    const expense = expenses.find((e) => e.id === id);
    
    // Reverse linked journal entry atomically before deleting.
    // Uses the canonical void RPC: posts a reversal sub-entry, marks original
    // as 'reversed', and is idempotent. NEVER mutates the original JE in place.
    if (expense && (expense as any).journal_entry_id) {
      const { error: voidErr } = await supabase.rpc("void_journal_entry_atomic", {
        _entry_id: (expense as any).journal_entry_id,
        _reason: `Expense deleted: ${expense.description}`,
        _user_id: undefined,
        _entry_number: null,
        _reversal_date: null,
      } as any);
      if (voidErr) {
        console.error("Failed to reverse JE on expense delete:", voidErr);
        throw voidErr;
      }
    }

    // Optimistic update
    setExpenses((prev) => prev.filter((e) => e.id !== id));

    try {
      const { error } = await supabase.from("expenses").delete().eq("id", id);
      if (error) throw error;

      // Log deletion
      if (expense) {
        logAction({
          action: "deleted",
          entityType: "expense",
          entityId: id,
          entityName: expense.description,
          changesSummary: `Deleted expense: ${expense.description}${(expense as any).journal_entry_id ? " (GL entry voided)" : ""}`,
        });
      }
    } catch (error) {
      // Rollback on error
      if (expense) {
        setExpenses((prev) => [...prev, expense]);
      }
      throw error;
    }
  };

  const createCategory = async (category: Omit<ExpenseCategory, "id" | "organization_id" | "created_at">) => {
    if (!currentOrg) throw new Error("No organization selected");

    const insertData = {
      ...category,
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id || null,
    };

    const { data, error } = await supabase
      .from("expense_categories")
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;
    await fetchCategories();
    return data;
  };

  const updateCategory = async (id: string, updates: Partial<ExpenseCategory>) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { error } = await supabase
      .from("expense_categories")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    await fetchCategories();
  };

  const deleteCategory = async (id: string) => {
    if (!currentOrg) throw new Error("No organization selected");

    // Soft-delete to preserve referential integrity
    const { error } = await supabase
      .from("expense_categories")
      .update({ is_active: false } as any)
      .eq("id", id);

    if (error) throw error;
    await fetchCategories();
  };

  return {
    expenses,
    categories,
    isLoading,
    createExpense,
    updateExpense,
    deleteExpense,
    createCategory,
    updateCategory,
    deleteCategory,
    refreshExpenses: fetchExpenses,
  };
}
