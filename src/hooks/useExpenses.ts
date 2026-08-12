import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import {
  isExpenseDeletable,
  submitExpense as submitExpenseRpc,
  voidExpenseRpc,
  type ExpenseStatus,
} from "@/lib/finance/expenseCommands";
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
  /** Server-computed from `tax_rate_id` — never written by the client. */
  tax_amount?: number;
  tax_rate_id?: string | null;
  tax_treatment?: "recoverable" | "non_recoverable";
  /** Server-resolved from `exchange_rates` on the expense date. */
  exchange_rate?: number;
  base_amount?: number;
  department_id?: string | null;
  analytic_account_id?: string | null;
  project_id?: string | null;
  currency: string;
  description: string;
  reference: string | null;
  receipt_url: string | null;
  status: ExpenseStatus;
  payment_method: string;
  is_billable: boolean;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  category?: ExpenseCategory | null;
  vendor?: { name: string } | null;
}

/** Identity on the select string — keeps it out of the type-level parser. */
const sel = (s: string): string => s;



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
      // `sel()` keeps the embedded-select string out of the type-level parser
      // (see query-builder-type-performance); `.returns<>()` pins the shape.
      let q = supabase
        .from("expenses")
        .select(sel("*, category:expense_categories(*), vendor:contacts(name)"))
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("expense_date", { ascending: false })
        .returns<Expense[]>();
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

  // The expense lifecycle is server-owned: `expense_submit` / `expense_approve`
  // / `expense_void` route governance, enforce segregation of duties and post
  // to the GL in one transaction (ADR 0123, ADR-0101). This hook only authors
  // commercial fields.

  const stripServerOwned = (input: Record<string, any>) => {
    const {
      status,
      approved_by,
      approved_at,
      approval_request_id,
      journal_entry_id,
      submitted_by,
      submitted_at,
      voided_at,
      voided_by,
      rejected_reason,
      base_amount,
      exchange_rate,
      tax_amount,
      expense_number,
      reimburse_via_payroll,
      reimbursed_at,
      reimbursed_by,
      reimbursed_payslip_id,
      reimbursed_run_id,
      category,
      vendor,
      ...rest
    } = input;
    return rest;
  };

  const createExpense = async (
    expense: Omit<Expense, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "category" | "vendor"> & {
      submit?: boolean;
    }
  ) => {
    if (!can("manageFinancials")) throw new Error("Permission denied: cannot create expenses");
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const { submit = true, ...fields } = expense as any;

    const insertData = {
      ...stripServerOwned(fields),
      // status is server-owned: the column defaults to 'draft' and the
      // insert policy rejects any other entry state.
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      // Stamp branch from active context — prevents NULL-branch leak.
      branch_id: fields.branch_id ?? currentBranch?.id ?? null,
      created_by: user.id,
    };

    const { data, error } = await supabase
      .from("expenses")
      .insert(insertData as any)
      .select()
      .single();

    if (error) throw error;

    logAction({
      action: "created",
      entityType: "expense",
      entityId: data.id,
      entityName: expense.description,
      changesSummary: `Created expense: ${expense.description} for ${expense.amount}`,
    });

    // Governance decides whether this waits for an approver or posts now.
    if (submit) await submitExpenseRpc(data.id);

    await fetchExpenses();

    triggerAutomation({
      event_type: "on_create",
      target_model: "expense",
      record_id: data.id,
      record_data: data,
      organization_id: currentOrg.id,
    });

    return data;
  };

  /** Edits commercial fields only — state transitions go through the RPCs. */
  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    const expense = expenses.find((e) => e.id === id);
    const dbUpdates = stripServerOwned(updates as any);

    // Optimistic update
    setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, ...dbUpdates } : e)));

    try {
      if (Object.keys(dbUpdates).length > 0) {
        const { error } = await supabase.from("expenses").update(dbUpdates as any).eq("id", id);
        if (error) throw error;
      }

      if (expense) {
        logAction({
          action: "updated",
          entityType: "expense",
          entityId: id,
          entityName: expense.description,
          changesSummary: `Updated expense: ${expense.description}`,
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

  /**
   * Void a posted expense — reversal + audit happen server-side.
   *
   * A reason code from `reversal_reason_codes` is mandatory (ADR 0129); the
   * server refuses the void without one, so callers must come through
   * `VoidExpenseDialog` rather than firing this from a menu item.
   */
  const voidExpense = async (id: string, reason?: string, reasonCode?: string) => {
    const expense = expenses.find((e) => e.id === id);
    const res = await voidExpenseRpc(
      id,
      reason ?? (expense ? `Void of expense: ${expense.description}` : null),
      reasonCode ?? null,
    );

    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "expense",
        entityId: id,
        event: "rejected",
        actorUserId: user?.id ?? null,
      });
    }

    await fetchExpenses();
    return res;
  };

  const deleteExpense = async (id: string) => {
    const expense = expenses.find((e) => e.id === id);

    // Posted expenses are voided, never deleted — the ledger keeps its history.
    if (expense && !isExpenseDeletable(expense.status)) {
      throw new Error("Only unposted expenses can be deleted. Use void for approved or paid expenses.");
    }

    // Optimistic update
    setExpenses((prev) => prev.filter((e) => e.id !== id));

    try {
      const { error } = await supabase.from("expenses").delete().eq("id", id);
      if (error) throw error;

      if (expense) {
        logAction({
          action: "deleted",
          entityType: "expense",
          entityId: id,
          entityName: expense.description,
          changesSummary: `Deleted unposted expense: ${expense.description}`,
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
    voidExpense,
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
