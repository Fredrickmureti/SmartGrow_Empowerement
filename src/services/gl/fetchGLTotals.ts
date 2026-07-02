/**
 * GL-based Revenue & Expenses calculation
 * 
 * Single source of truth for financial KPIs.
 * Uses the `get_account_movements` RPC (posted journal entries only)
 * to ensure dashboard numbers match formal financial reports exactly.
 */

import { supabase } from "@/integrations/supabase/client";

export interface GLTotals {
  revenue: number;
  expenses: number;
  netProfit: number;
}

/**
 * Fetch GL-based revenue & expenses for a date range using posted journal entries.
 * This ensures all KPIs match the financial reports (single source of truth).
 *
 * @param branchId optional branch dimension filter; NULL = all branches.
 */
export async function fetchGLTotals(
  orgId: string,
  dateFrom: string,
  dateTo: string,
  businessId?: string | null,
  branchId?: string | null
): Promise<GLTotals> {
  // 1. Get account movements from GL (posted journal entries only)
  const { data: movements, error: movError } = await supabase.rpc("get_account_movements", {
    _org_id: orgId,
    _date_from: dateFrom,
    _date_to: dateTo,
    _business_id: businessId || null,
    _branch_id: branchId || null,
  });
  if (movError) throw movError;

  // 2. Get accounts to determine which are income vs expense
  let accountsQuery = supabase
    .from("accounts")
    .select("id, account_type")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .in("account_type", ["income", "expense"]);
  if (businessId) {
    accountsQuery = accountsQuery.or(`business_id.eq.${businessId},business_id.is.null`);
  }
  const { data: accounts, error: acctError } = await accountsQuery;
  if (acctError) throw acctError;

  // Build a lookup of account_id -> account_type
  const typeMap = new Map<string, string>();
  for (const acct of accounts || []) {
    typeMap.set(acct.id, acct.account_type);
  }

  // 3. Sum movements by type (same logic as the financial report engine)
  let revenue = 0;
  let expenses = 0;
  for (const mov of movements || []) {
    const type = typeMap.get(mov.account_id);
    if (type === "income") {
      // Income: credit-normal, so revenue = credits - debits
      revenue += (Number(mov.total_credit) || 0) - (Number(mov.total_debit) || 0);
    } else if (type === "expense") {
      // Expense: debit-normal, so expense = debits - credits
      expenses += (Number(mov.total_debit) || 0) - (Number(mov.total_credit) || 0);
    }
  }

  return { revenue, expenses, netProfit: revenue - expenses };
}
