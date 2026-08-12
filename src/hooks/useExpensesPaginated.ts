import { useState, useEffect } from "react";
import { usePaginatedQuery } from "./usePaginatedQuery";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useQueryClient } from "@tanstack/react-query";
import { useDefaultAccounts } from "./useDefaultAccounts";
import {
  approveExpense as approveExpenseRpc,
  convertExpenseToBill,
  queueExpensePayrollReimbursement as queuePayrollReimbursementRpc,
  reimburseExpenseDirect,
  unqueueExpensePayrollReimbursement as unqueuePayrollReimbursementRpc,
  isExpenseDeletable,
  rejectExpense as rejectExpenseRpc,
  submitExpense as submitExpenseRpc,
  voidExpenseRpc,
  type ExpenseStatus,
} from "@/lib/finance/expenseCommands";
import { usePermissions } from "./usePermissions";
import { applyBranchFilter } from "@/lib/branchScope";

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
  department_id?: string | null;
  analytic_account_id?: string | null;
  project_id?: string | null;
  currency: string;
  description: string;
  reference: string | null;
  receipt_url: string | null;
  status: ExpenseStatus;
  payment_method: string;
  /** Who fronted the cash: company | employee | company_card. */
  paid_by?: string | null;
  is_billable: boolean;
  created_by: string | null;
  approved_by: string | null;
  approval_request_id?: string | null;
  employee_id?: string | null;
  reimburse_via_payroll?: boolean | null;
  reimbursed_payslip_id?: string | null;
  reimbursed_run_id?: string | null;
  reimbursed_at?: string | null;
  base_amount?: number | null;
  exchange_rate?: number | null;
  journal_entry_id: string | null;
  created_at: string;
  updated_at: string;
  category?: ExpenseCategory | null;
  vendor?: { name: string } | null;
  payment_account?: { id: string; name: string; code: string } | null;
}

export interface UseExpensesPaginatedOptions {
  statusFilter?: string;
  search?: string;
  pageSize?: number;
}

export function useExpensesPaginated(options: UseExpensesPaginatedOptions = {}) {
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranch();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const queryClient = useQueryClient();
  const { accounts } = useDefaultAccounts();
  const { can } = usePermissions();
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);

  const { statusFilter, search, pageSize = 50 } = options;
  const businessId = currentBusiness?.id;

  const branchId = currentBranch?.id ?? null;
  const queryKey = ["expenses", currentOrg?.id, businessId, branchId, statusFilter, search];

  const result = usePaginatedQuery<Expense>({
    queryKey,
    queryFn: async ({ from, to }) => {
      if (!currentOrg || !businessId) return { data: [], count: 0 };

      let query = supabase
        .from("expenses")
        .select(
          `
          *,
          category:expense_categories(*),
          vendor:contacts(name),
          payment_account:accounts!expenses_payment_account_id_fkey(id, name, code)
        `,
          { count: "exact" }
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .order("expense_date", { ascending: false });

      query = applyBranchFilter(query, branchId);

      if (statusFilter && statusFilter !== "all") {
        query = query.eq("status", statusFilter as ExpenseStatus);
      }

      if (search) {
        query = query.or(`description.ilike.%${search}%,reference.ilike.%${search}%`);
      }

      query = query.range(from, to);

      const { data, count, error } = await query;

      if (error) throw error;

      return { data: (data || []) as Expense[], count: count || 0 };
    },
    pageSize,
    enabled: !!currentOrg && !!businessId,
  });

  // Fetch categories separately
  useEffect(() => {
    const fetchCategories = async () => {
      if (!currentOrg) return;

      let query = supabase
        .from("expense_categories")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("name");

      // Business-scope: show categories for this business OR org-wide (null business_id)
      if (businessId) {
        query = query.or(`business_id.eq.${businessId},business_id.is.null`);
      }

      const { data, error } = await query;

      if (!error && data) {
        setCategories(data as ExpenseCategory[]);
      }
    };

    fetchCategories();
  }, [currentOrg?.id, businessId]);

  // GL posting for expenses is server-side only — account resolution, tax
  // splitting and journal composition live in `public.post_expense_gl`
  // (ADR 0123: Single Journal Posting Monopoly).

  /**
   * Checks if a given account ID is the Accounts Payable account.
   */
  const isAPAccount = (accountId: string | null): boolean => {
    if (!accountId || !accounts.accounts_payable_id) return false;
    return accountId === accounts.accounts_payable_id;
  };

  /**
   * Converts an expense into a vendor bill.
   *
   * The bill is minted by `public.expense_convert_to_bill` in a single
   * transaction: numbering, header, line and audit entry together, guarded by a
   * unique index on `bills.source_expense_id` so a retry can never produce a
   * second bill. The browser no longer composes bills — that was the source of
   * duplicate payables.
   */
  const createLinkedBill = async (
    expenseId: string
  ): Promise<{ success: boolean; bill?: { id: string; bill_number: string }; error?: string }> => {
    try {
      const res = await convertExpenseToBill(expenseId);
      logAction({
        action: "created",
        entityType: "bill",
        entityId: res.bill_id,
        entityName: res.bill_number,
        changesSummary: `Vendor bill ${res.bill_number} created from expense`,
      });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      queryClient.invalidateQueries({ queryKey: ["aging-report"] });
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      return { success: true, bill: { id: res.bill_id, bill_number: res.bill_number } };
    } catch (err: any) {
      const errorMsg = err?.message || "Unknown error";
      toast({
        title: "Vendor bill was not created",
        description: errorMsg,
        variant: "destructive",
        duration: 12000,
      });
      return { success: false, error: errorMsg };
    }
  };


  /** Fields the client is allowed to author. Everything else is server-owned. */
  const stripServerOwned = <T extends Record<string, any>>(input: T) => {
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
      payment_account,
      ...rest
    } = input as any;
    return rest;
  };

  /**
   * Captures an expense and hands it to the lifecycle engine.
   *
   * The row is always inserted as `draft`; `expense_submit` then decides —
   * from the org's governance rules — whether it waits for approval or is
   * approved and posted immediately. The browser never writes a status.
   */
  const createExpense = async (
    expense: Omit<
      Expense,
      | "id"
      | "organization_id"
      | "created_at"
      | "updated_at"
      | "created_by"
      | "category"
      | "vendor"
      | "journal_entry_id"
      | "status"
      | "approved_by"
    > & { submit?: boolean }
  ): Promise<{ data: any; billCreated: boolean; gated: boolean }> => {
    if (!can("manageFinancials")) throw new Error("Permission denied: cannot create expenses");
    if (!currentOrg || !user) throw new Error("No organization selected");

    const { submit = true, ...fields } = expense as any;

    const { data, error } = await supabase
      .from("expenses")
      .insert({
        ...stripServerOwned(fields),
        // status is server-owned: the column defaults to 'draft' and the
        // insert policy rejects any other entry state.
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        branch_id: fields.branch_id ?? currentBranch?.id ?? null,
        created_by: user.id,
      } as any)
      .select()
      .single();

    if (error) throw error;

    logAction({
      action: "created",
      entityType: "expense",
      entityId: data.id,
      entityName: expense.description,
      changesSummary: `Created expense: ${expense.description} for ${expense.amount} (${expense.payment_method})`,
    });

    let gated = false;
    if (submit) {
      const res = await submitExpenseRpc(data.id);
      gated = !!res?.gated;
    }

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    return { data, billCreated: false, gated };
  };

  /** Edits the commercial fields of an unposted expense. Never its state. */
  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    const payload = stripServerOwned(updates as any);

    if (Object.keys(payload).length > 0) {
      const { error } = await supabase.from("expenses").update(payload as any).eq("id", id);
      if (error) throw error;
    }

    logAction({
      action: "updated",
      entityType: "expense",
      entityId: id,
      changesSummary: `Updated expense`,
    });

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
  };

  /** Sends a draft/rejected expense into the approval workflow. */
  const submitExpense = async (id: string) => {
    const res = await submitExpenseRpc(id);
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    queryClient.invalidateQueries({ queryKey: ["approval-requests"] });
    return res;
  };

  /** Approves and posts an expense that policy did not gate. */
  const approveExpense = async (id: string) => {
    const res = await approveExpenseRpc(id);
    logAction({ action: "approved", entityType: "expense", entityId: id, changesSummary: "Approved expense" });
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    return res;
  };

  const rejectExpense = async (id: string, reason?: string) => {
    const res = await rejectExpenseRpc(id, reason);
    logAction({ action: "rejected", entityType: "expense", entityId: id, changesSummary: reason ?? "Rejected expense" });
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    return res;
  };


  /**
   * Void an approved/paid expense.
   *
   * `expense_void` reverses the journal entry through
   * `void_journal_entry_atomic`, refuses when the expense has already been
   * reimbursed or spawned a vendor bill, and records the reason in the audit
   * trail — all in one transaction.
   */
  const voidExpense = async (id: string, reason?: string, reasonCode?: string) => {
    const currentExpense = result.data.find((e) => e.id === id);
    const res = await voidExpenseRpc(
      id,
      reason ?? (currentExpense ? `Void of expense: ${currentExpense.description}` : null),
      reasonCode ?? null,
    );

    logAction({
      action: "voided",
      entityType: "expense",
      entityId: id,
      entityName: currentExpense?.description,
      changesSummary: `Voided expense${currentExpense ? `: ${currentExpense.description} (${currentExpense.amount})` : ""}. Reversing JE created.`,
    });

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    return res;
  };

  /**
   * Queue an employee-paid expense for reimbursement in the next payroll run.
   * `compute-payroll` (Turn C) consumes the flag and stamps the payslip link.
   */
  const queuePayrollReimbursement = async (id: string, employeeId?: string | null) => {
    const res = await queuePayrollReimbursementRpc(id, employeeId);
    logAction({
      action: "updated",
      entityType: "expense",
      entityId: id,
      changesSummary: "Queued for payroll reimbursement",
    });
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    return res;
  };

  const unqueuePayrollReimbursement = async (id: string) => {
    const res = await unqueuePayrollReimbursementRpc(id);
    logAction({
      action: "updated",
      entityType: "expense",
      entityId: id,
      changesSummary: "Removed from payroll reimbursement queue",
    });
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    return res;
  };

  /** Settle the employee payable straight from a bank/cash account. */
  const reimburseDirect = async (
    id: string,
    bankAccountId: string,
    paymentDate?: string | null,
    reference?: string | null,
  ) => {
    const res = await reimburseExpenseDirect(id, bankAccountId, paymentDate, reference);
    logAction({
      action: "updated",
      entityType: "expense",
      entityId: id,
      changesSummary: "Reimbursed employee directly",
    });
    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    return res;
  };

  /**
   * Delete an expense — ONLY allowed while nothing has reached the ledger.
   * Approved/paid expenses must be voided instead.
   */
  const deleteExpense = async (id: string) => {
    const currentExpense = result.data.find((e) => e.id === id);

    // Safety guard: never hard-delete posted expenses
    if (currentExpense && !isExpenseDeletable(currentExpense.status)) {
      throw new Error("Only unposted expenses can be deleted. Use void for approved/paid expenses.");
    }

    const { error } = await supabase.from("expenses").delete().eq("id", id);
    if (error) throw error;

    logAction({
      action: "deleted",
      entityType: "expense",
      entityId: id,
      changesSummary: `Deleted unposted expense`,
    });

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
  };


  const createCategory = async (
    category: Omit<ExpenseCategory, "id" | "organization_id" | "created_at"> & { account_id?: string | null }
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase
      .from("expense_categories")
      .insert({
        ...category,
        organization_id: currentOrg.id,
        business_id: businessId || null,
      })
      .select()
      .single();

    if (error) throw error;

    let refreshQuery = supabase
      .from("expense_categories")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true)
      .order("name");

    if (businessId) {
      refreshQuery = refreshQuery.or(`business_id.eq.${businessId},business_id.is.null`);
    }

    const { data: newCategories } = await refreshQuery;

    if (newCategories) {
      setCategories(newCategories as ExpenseCategory[]);
    }

    return data;
  };

  const updateCategory = async (id: string, updates: Partial<ExpenseCategory>) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { error } = await supabase
      .from("expense_categories")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;

    // Refresh categories
    let refreshQuery = supabase
      .from("expense_categories")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true)
      .order("name");

    if (businessId) {
      refreshQuery = refreshQuery.or(`business_id.eq.${businessId},business_id.is.null`);
    }

    const { data: newCategories } = await refreshQuery;
    if (newCategories) setCategories(newCategories as ExpenseCategory[]);
  };

  const deleteCategory = async (id: string) => {
    if (!currentOrg) throw new Error("No organization selected");

    // Soft-delete: deactivate instead of hard delete to preserve referential integrity
    const { error } = await supabase
      .from("expense_categories")
      .update({ is_active: false } as any)
      .eq("id", id);

    if (error) throw error;

    setCategories((prev) => prev.filter((c) => c.id !== id));
  };

  return {
    ...result,
    expenses: result.data,
    categories,
    createExpense,
    updateExpense,
    submitExpense,
    approveExpense,
    rejectExpense,
    deleteExpense,
    voidExpense,
    queuePayrollReimbursement,
    unqueuePayrollReimbursement,
    reimburseDirect,
    createCategory,
    updateCategory,
    deleteCategory,
    createLinkedBill,
    isAPAccount,
  };
}
