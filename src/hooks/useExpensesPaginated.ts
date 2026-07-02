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
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { usePermissions } from "./usePermissions";
import { usePaymentTerms } from "./usePaymentTerms";
import type { Database } from "@/integrations/supabase/types";
import { applyBranchFilter } from "@/lib/branchScope";

type BillInsert = Database["public"]["Tables"]["bills"]["Insert"];

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
  status: "pending" | "approved" | "rejected" | "paid" | "voided";
  payment_method: string;
  is_billable: boolean;
  created_by: string | null;
  approved_by: string | null;
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
  const { postToGL, postExpenseToGL } = useGLPosting();
  const { accounts, getExpenseAccountMappings, hasRequiredAccounts } = useDefaultAccounts();
  const { can } = usePermissions();
  const { defaultPaymentTerm } = usePaymentTerms();
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
        query = query.eq("status", statusFilter as "pending" | "approved" | "rejected" | "paid");
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

  /**
   * Resolves the GL expense (debit) account using priority chain:
   * 1. expense.account_id (manual override on expense record)
   * 2. category.account_id (category→COA mapping)
   * 3. operating_expenses_id (system default fallback)
   */
  const resolveExpenseAccountId = (expense: {
    account_id: string | null;
    category_id: string | null;
  }): string => {
    // Priority 1: explicit account on the expense
    if (expense.account_id) return expense.account_id;

    // Priority 2: category's mapped account
    if (expense.category_id) {
      const cat = categories.find(c => c.id === expense.category_id);
      if (cat?.account_id) return cat.account_id;
    }

    // Priority 3: system default
    return getExpenseAccountMappings().expense_account_id;
  };

  /**
   * Posts expense to GL when status is approved or paid.
   * Creates: Dr Expense Account / Cr Payment Account
   * If tax_amount > 0 and input_tax account exists:
   *   Dr Expense Account (net = amount - tax)
   *   Dr Input Tax Asset (tax_amount)
   *   Cr Payment Account (amount)
   */
  const postExpenseGL = async (expense: {
    id: string;
    expense_date: string;
    amount: number;
    tax_amount: number;
    description: string;
    reference: string | null;
    payment_method: string;
    account_id: string | null;
    payment_account_id: string | null;
    category_id: string | null;
  }) => {
    if (!hasRequiredAccounts()) return null;

    const resolvedPaymentAccountId = expense.payment_account_id
      || getExpenseAccountMappings(expense.payment_method, expense.account_id || undefined).payment_account_id;

    const expenseAccountId = resolveExpenseAccountId(expense);

    if (!expenseAccountId || !resolvedPaymentAccountId) {
      console.warn("Expense GL posting skipped: missing account mappings");
      return null;
    }

    // Build GL entries
    const entries: { account_id: string; debit_amount: number; credit_amount: number; description: string }[] = [];
    const inputTaxAccountId = accounts.input_tax_account_id;
    const hasTax = expense.tax_amount > 0 && inputTaxAccountId;
    const netAmount = hasTax ? expense.amount - expense.tax_amount : expense.amount;

    // Dr Expense Account (net amount)
    entries.push({
      account_id: expenseAccountId,
      debit_amount: netAmount,
      credit_amount: 0,
      description: `Expense - ${expense.description}`,
    });

    // Dr Input Tax Asset (if applicable)
    if (hasTax) {
      entries.push({
        account_id: inputTaxAccountId!,
        debit_amount: expense.tax_amount,
        credit_amount: 0,
        description: `Expense Input Tax - ${expense.description}`,
      });
    }

    // Cr Payment Account (total amount)
    entries.push({
      account_id: resolvedPaymentAccountId,
      debit_amount: 0,
      credit_amount: expense.amount,
      description: `Expense payment - ${expense.description}`,
    });

    try {
      const jeId = await postToGL({
        source_type: "expense",
        source_id: expense.id,
        reference: expense.reference || `EXP-${expense.id.slice(0, 8)}`,
        memo: `Expense: ${expense.description}`,
        entry_date: expense.expense_date,
        entries,
      });

      // Link journal entry back to expense
      if (jeId) {
        await supabase
          .from("expenses")
          .update({ journal_entry_id: jeId } as any)
          .eq("id", expense.id);
      }

      return jeId;
    } catch (glError: any) {
      console.error("GL posting failed for expense:", glError);
      throw new Error(`Expense saved but GL posting failed: ${glError?.message || "Unknown error"}`);
    }
  };

  /**
   * Checks if a given account ID is the Accounts Payable account.
   */
  const isAPAccount = (accountId: string | null): boolean => {
    if (!accountId || !accounts.accounts_payable_id) return false;
    return accountId === accounts.accounts_payable_id;
  };

  /**
   * Auto-creates a vendor bill linked to an expense when the expense
   * credits Accounts Payable. This bridges the gap between the expense
   * record and the operational payable lifecycle.
   * 
   * Includes retry logic: attempts once, retries once on failure.
   */
  const createLinkedBill = async (expenseData: {
    id: string;
    description: string;
    amount: number;
    tax_amount: number;
    expense_date: string;
    vendor_id: string | null;
    reference: string | null;
    currency?: string | null;
  }): Promise<{ success: boolean; bill?: any; error?: string }> => {
    if (!currentOrg || !currentBusiness || !user) {
      return { success: false, error: "Missing organization, business, or user context" };
    }

    const attemptCreate = async (): Promise<any> => {
      // Get next bill number
      const { data: billNumber, error: numError } = await supabase.rpc("get_next_bill_number", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _branch_id: currentBranch?.id ?? null,
      } as any);
      if (numError) throw numError;
      if (!billNumber) throw new Error("Failed to generate bill number");

      // Calculate due date from payment terms
      const billDate = expenseData.expense_date;
      const dueDate = (() => {
        const date = new Date(billDate);
        const days = defaultPaymentTerm?.days || 30;
        date.setDate(date.getDate() + days);
        return date.toISOString().split("T")[0];
      })();

      const subtotal = expenseData.amount - (expenseData.tax_amount || 0);

      const billInsert: BillInsert = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        // Stage 3: stamp active branch (expense→bill is a runtime event).
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
        bill_number: billNumber,
        vendor_id: expenseData.vendor_id,
        bill_date: billDate,
        due_date: dueDate,
        subtotal: subtotal,
        tax_amount: expenseData.tax_amount || 0,
        total: expenseData.amount,
        amount_paid: 0,
        status: "received",
        currency: expenseData.currency || currentBusiness?.base_currency,
        notes: `Auto-created from expense: ${expenseData.description}`,
        vendor_invoice_number: expenseData.reference,
        source_expense_id: expenseData.id,
      } as BillInsert;

      const { data: bill, error: billError } = await supabase
        .from("bills")
        .insert(billInsert)
        .select()
        .single();

      if (billError) throw billError;

      // Create a single line item for the bill
      await supabase.from("bill_items").insert({
        bill_id: bill.id,
        description: expenseData.description,
        quantity: 1,
        unit_price: subtotal,
        tax_rate: expenseData.tax_amount > 0 ? (expenseData.tax_amount / subtotal) * 100 : 0,
        tax_amount: expenseData.tax_amount || 0,
        line_total: subtotal,
        sort_order: 0,
      });

      return bill;
    };

    // Attempt 1
    try {
      const bill = await attemptCreate();
      
      logAction({
        action: "created",
        entityType: "bill",
        entityId: bill.id,
        entityName: bill.bill_number,
        changesSummary: `Auto-created bill ${bill.bill_number} from AP expense: ${expenseData.description}`,
      });

      return { success: true, bill };
    } catch (firstError: any) {
      console.warn("Bill creation attempt 1 failed, retrying:", firstError.message);
      
      // Attempt 2 (retry)
      try {
        const bill = await attemptCreate();
        
        logAction({
          action: "created",
          entityType: "bill",
          entityId: bill.id,
          entityName: bill.bill_number,
          changesSummary: `Auto-created bill ${bill.bill_number} from AP expense (retry): ${expenseData.description}`,
        });

        return { success: true, bill };
      } catch (retryError: any) {
        const errorMsg = retryError?.message || "Unknown error";
        console.error("Bill creation failed after retry:", errorMsg);
        
        // Show persistent destructive toast with clear messaging
        toast({
          title: "⚠️ Vendor bill was NOT created",
          description: `The expense was saved and posted to GL, but the linked vendor bill failed: ${errorMsg}. Use the "Create Bill" action on the expense to retry.`,
          variant: "destructive",
          duration: 15000, // 15 seconds - much longer than default
        });

        return { success: false, error: errorMsg };
      }
    }
  };

  const createExpense = async (
    expense: Omit<
      Expense,
      "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "category" | "vendor" | "journal_entry_id"
    >
  ): Promise<{ data: any; billCreated: boolean }> => {
    if (!can("manageFinancials")) throw new Error("Permission denied: cannot create expenses");
    if (!currentOrg || !user) throw new Error("No organization selected");

    const isPayableExpense = isAPAccount(expense.payment_account_id);

    const { data, error } = await supabase
      .from("expenses")
      .insert({
        ...expense,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
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
      changesSummary: `Created expense: ${expense.description} for ${expense.amount} (${expense.payment_method})${isPayableExpense ? " [AP - linked bill will be created]" : ""}`,
    });

    let billCreated = false;

    if (isPayableExpense) {
      // AP expense: create a linked vendor bill + post GL via the expense GL engine
      if (expense.status === "approved" || expense.status === "paid") {
        await postExpenseGL({
          id: data.id,
          expense_date: expense.expense_date,
          amount: expense.amount,
          tax_amount: expense.tax_amount || 0,
          description: expense.description,
          reference: expense.reference,
          payment_method: expense.payment_method,
          account_id: expense.account_id,
          payment_account_id: expense.payment_account_id,
          category_id: expense.category_id,
        });
      }

      // Auto-create the linked bill for payable lifecycle management
      const billResult = await createLinkedBill({
        id: data.id,
        description: expense.description,
        amount: expense.amount,
        tax_amount: expense.tax_amount || 0,
        expense_date: expense.expense_date,
        vendor_id: expense.vendor_id,
        reference: expense.reference,
        currency: expense.currency,
      });

      billCreated = billResult.success;

      // Invalidate bills + aging queries so they appear immediately
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      queryClient.invalidateQueries({ queryKey: ["aging-report"] });
    } else {
      // Standard expense: post GL normally
      if (expense.status === "approved" || expense.status === "paid") {
        await postExpenseGL({
          id: data.id,
          expense_date: expense.expense_date,
          amount: expense.amount,
          tax_amount: expense.tax_amount || 0,
          description: expense.description,
          reference: expense.reference,
          payment_method: expense.payment_method,
          account_id: expense.account_id,
          payment_account_id: expense.payment_account_id,
          category_id: expense.category_id,
        });
      }
    }

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    return { data, billCreated };
  };

  const updateExpense = async (id: string, updates: Partial<Expense>) => {
    // Fetch current expense to detect status transitions
    const currentExpense = result.data.find((e) => e.id === id);

    const { error } = await supabase.from("expenses").update(updates as any).eq("id", id);

    if (error) throw error;

    // Post to GL on status transition to approved/paid
    const statusChanged = updates.status && currentExpense && updates.status !== currentExpense.status;
    const shouldPostGL = statusChanged && (updates.status === "approved" || updates.status === "paid");

    if (shouldPostGL && currentExpense) {
      await postExpenseGL({
        id: currentExpense.id,
        expense_date: updates.expense_date || currentExpense.expense_date,
        amount: updates.amount || currentExpense.amount,
        tax_amount: updates.tax_amount !== undefined ? updates.tax_amount : currentExpense.tax_amount || 0,
        description: updates.description || currentExpense.description,
        reference: updates.reference !== undefined ? updates.reference : currentExpense.reference,
        payment_method: (updates as any).payment_method || currentExpense.payment_method || "cash",
        account_id: updates.account_id !== undefined ? updates.account_id : currentExpense.account_id,
        payment_account_id: updates.payment_account_id !== undefined ? updates.payment_account_id : currentExpense.payment_account_id,
        category_id: updates.category_id !== undefined ? updates.category_id : currentExpense.category_id,
      });
    }

    // Fix 4: Create linked bill when transitioning to AP account
    const resolvedPaymentAccountId = updates.payment_account_id !== undefined 
      ? updates.payment_account_id 
      : currentExpense?.payment_account_id;
    
    if (isAPAccount(resolvedPaymentAccountId || null) && currentExpense) {
      // Check if a linked bill already exists
      const { data: existingBill } = await supabase
        .from("bills")
        .select("id")
        .eq("source_expense_id", id)
        .maybeSingle();

      if (!existingBill) {
        const mergedExpense = { ...currentExpense, ...updates };
        await createLinkedBill({
          id,
          description: mergedExpense.description || currentExpense.description,
          amount: mergedExpense.amount || currentExpense.amount,
          tax_amount: mergedExpense.tax_amount !== undefined ? mergedExpense.tax_amount : currentExpense.tax_amount || 0,
          expense_date: mergedExpense.expense_date || currentExpense.expense_date,
          vendor_id: mergedExpense.vendor_id || currentExpense.vendor_id,
          reference: mergedExpense.reference !== undefined ? mergedExpense.reference : currentExpense.reference,
          currency: mergedExpense.currency || currentExpense.currency,
        });

        queryClient.invalidateQueries({ queryKey: ["bills"] });
        queryClient.invalidateQueries({ queryKey: ["aging-report"] });
      }
    }

    logAction({
      action: "updated",
      entityType: "expense",
      entityId: id,
      changesSummary: `Updated expense`,
    });

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
  };

  /**
   * Void an approved/paid expense — creates a reversing JE and preserves the record.
   *
   * Uses the canonical `void_journal_entry_atomic` RPC which:
   *  - posts a reversal sub-entry (source_subtype='reversal') in one transaction
   *  - marks the original JE as 'reversed' (never mutates lines or amounts)
   *  - is idempotent on double-clicks
   * This is the ONLY correct way to undo a posted expense.
   */
  const voidExpense = async (id: string) => {
    const currentExpense = result.data.find((e) => e.id === id);
    if (!currentExpense) throw new Error("Expense not found");
    if (currentExpense.status === "pending" || currentExpense.status === "voided") {
      throw new Error("Only approved or paid expenses can be voided");
    }

    // Reverse the linked JE atomically (flip dr/cr, mark original reversed)
    if (currentExpense.journal_entry_id) {
      const { error: voidErr } = await supabase.rpc("void_journal_entry_atomic", {
        _entry_id: currentExpense.journal_entry_id,
        _reason: `Void of expense: ${currentExpense.description}`,
        _user_id: undefined,
        _entry_number: null,
        _reversal_date: null,
      } as any);
      if (voidErr) throw voidErr;
    }

    // Step 2: Set expense status to voided (preserve the record)
    const { error } = await supabase
      .from("expenses")
      .update({ status: "voided" } as any)
      .eq("id", id);
    if (error) throw error;

    logAction({
      action: "voided",
      entityType: "expense",
      entityId: id,
      entityName: currentExpense.description,
      changesSummary: `Voided expense: ${currentExpense.description} (${currentExpense.amount}). Reversing JE created.`,
    });

    queryClient.invalidateQueries({ queryKey: ["expenses"] });
    queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
  };

  /**
   * Delete an expense — ONLY allowed for pending (unposted) expenses.
   * Approved/paid expenses must be voided instead.
   */
  const deleteExpense = async (id: string) => {
    const currentExpense = result.data.find((e) => e.id === id);
    
    // Safety guard: never hard-delete posted expenses
    if (currentExpense && currentExpense.status !== "pending") {
      throw new Error("Only pending expenses can be deleted. Use void for approved/paid expenses.");
    }

    const { error } = await supabase.from("expenses").delete().eq("id", id);
    if (error) throw error;

    logAction({
      action: "deleted",
      entityType: "expense",
      entityId: id,
      changesSummary: `Deleted pending expense`,
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
    deleteExpense,
    voidExpense,
    createCategory,
    updateCategory,
    deleteCategory,
    createLinkedBill,
    isAPAccount,
  };
}
