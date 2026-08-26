/**
 * GL-based Revenue & Expenses.
 *
 * Single source of truth for financial KPIs: the `get_gl_pnl_totals` RPC, which
 * reads the authoritative `get_account_movements` engine (posted journal entries
 * only) and applies the normal-balance convention inside the database — income
 * credit-normal, expenses debit-normal.
 *
 * This file deliberately owns NO accounting arithmetic. It previously fetched
 * accounts, classified them as income/expense and summed movements in the
 * browser; that was a second definition of "revenue for a period" and could
 * drift from the formal Profit & Loss statement. Do not reintroduce it.
 */

import { supabase } from "@/integrations/supabase/client";

export interface GLTotals {
  revenue: number;
  expenses: number;
  netProfit: number;
}

/**
 * Fetch GL-based revenue & expenses for a date range using posted journal entries.
 *
 * @param branchId optional branch dimension filter; NULL = all branches.
 */
export async function fetchGLTotals(
  orgId: string,
  dateFrom: string,
  dateTo: string,
  businessId?: string | null,
  branchId?: string | null,
): Promise<GLTotals> {
  const { data, error } = await supabase.rpc("get_gl_pnl_totals", {
    _org_id: orgId,
    _date_from: dateFrom,
    _date_to: dateTo,
    _business_id: businessId || null,
    _branch_id: branchId || null,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    revenue: Number(row?.revenue ?? 0),
    expenses: Number(row?.expenses ?? 0),
    netProfit: Number(row?.net_profit ?? 0),
  };
}
