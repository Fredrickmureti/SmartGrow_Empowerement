/**
 * Client-side Z-Report and X-Report hooks
 * 
 * Replaces the dead RPC-based hooks with real client-side queries.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { format, startOfDay, endOfDay } from "date-fns";

export interface ReportTotals {
  total_sales: number;
  total_returns: number;
  total_voids: number;
  net_sales: number;
  total_tax: number;
  total_discounts: number;
  total_tips: number;
  transaction_count: number;
  void_count: number;
  return_count: number;
  avg_transaction?: number;
}

export interface PaymentBreakdown {
  payment_method: string;
  total_amount: number;
  transaction_count: number;
}

export interface TaxSummary {
  tax_rate: number;
  taxable_amount: number;
  tax_amount: number;
}

export interface ShiftSummary {
  shift_id: string;
  shift_number: string;
  user_id: string;
  opened_at: string;
  closed_at: string | null;
  status: string;
  opening_cash: number;
  expected_cash: number;
  actual_cash: number | null;
  cash_difference: number | null;
}

export interface ZReport {
  report_date: string;
  generated_at: string;
  organization_id: string;
  register_id: string | null;
  shifts: ShiftSummary[];
  totals: ReportTotals;
  payment_breakdown: PaymentBreakdown[];
  tax_summary: TaxSummary[];
}

export interface XReport {
  shift_id: string;
  shift_number: string;
  opened_at: string;
  status: string;
  opening_cash: number;
  expected_cash: number;
  totals: ReportTotals;
  payment_breakdown: PaymentBreakdown[];
  generated_at: string;
}

/**
 * Z-Report: End of Day report — client-side implementation.
 * Aggregates all shifts, transactions, payments, and tax for a given date.
 */
export function usePOSZReport(date?: string, registerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const reportDate = date || format(new Date(), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["pos-z-report", currentOrg?.id, businessId, reportDate, registerId],
    queryFn: async (): Promise<ZReport | null> => {
      if (!currentOrg?.id || !businessId) return null;

      const dayStart = startOfDay(new Date(reportDate)).toISOString();
      const dayEnd = endOfDay(new Date(reportDate)).toISOString();

      // Get shifts for the day
      let shiftsQuery = supabase
        .from("pos_shifts")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .gte("opened_at", dayStart)
        .lte("opened_at", dayEnd);

      if (registerId && registerId !== "all") {
        shiftsQuery = shiftsQuery.eq("register_id", registerId);
      }

      const { data: shifts } = await shiftsQuery;

      // Get transactions for the day
      let txQuery = supabase
        .from("pos_transactions")
        .select("id, total, transaction_type, status, tax_amount, discount_amount, tip_amount")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);

      if (registerId && registerId !== "all") {
        txQuery = txQuery.eq("register_id", registerId);
      }

      const { data: transactions } = await txQuery;

      if (!transactions) return null;

      // Compute totals
      const completedSales = transactions.filter(t => t.transaction_type === "sale" && t.status === "completed");
      const returns = transactions.filter(t => t.transaction_type === "return");
      const voids = transactions.filter(t => t.status === "voided");

      const totalSales = completedSales.reduce((s, t) => s + t.total, 0);
      const totalReturns = returns.reduce((s, t) => s + t.total, 0);
      const totalTax = completedSales.reduce((s, t) => s + (t.tax_amount || 0), 0);
      const totalDiscounts = completedSales.reduce((s, t) => s + (t.discount_amount || 0), 0);
      const totalTips = completedSales.reduce((s, t) => s + (t.tip_amount || 0), 0);

      // Payment breakdown
      const txIds = completedSales.map(t => t.id);
      const { data: payments } = await supabase
        .from("pos_transaction_payments")
        .select("payment_method, amount")
        .in("transaction_id", txIds);

      const paymentMap = new Map<string, { total: number; count: number }>();
      payments?.forEach(p => {
        if (!paymentMap.has(p.payment_method)) paymentMap.set(p.payment_method, { total: 0, count: 0 });
        paymentMap.get(p.payment_method)!.total += p.amount;
        paymentMap.get(p.payment_method)!.count += 1;
      });

      // Tax breakdown from items
      const { data: items } = await supabase
        .from("pos_transaction_items")
        .select("tax_rate, tax_amount, line_total")
        .in("transaction_id", txIds);

      const taxMap = new Map<number, { taxable: number; tax: number }>();
      items?.forEach(item => {
        const rate = item.tax_rate || 0;
        if (!taxMap.has(rate)) taxMap.set(rate, { taxable: 0, tax: 0 });
        taxMap.get(rate)!.taxable += item.line_total;
        taxMap.get(rate)!.tax += item.tax_amount || 0;
      });

      return {
        report_date: reportDate,
        generated_at: new Date().toISOString(),
        organization_id: currentOrg.id,
        register_id: registerId || null,
        shifts: (shifts || []).map(s => ({
          shift_id: s.id,
          shift_number: s.shift_number,
          user_id: s.user_id,
          opened_at: s.opened_at,
          closed_at: s.closed_at,
          status: s.status,
          opening_cash: s.opening_cash,
          expected_cash: s.expected_cash,
          actual_cash: s.actual_cash,
          cash_difference: s.cash_difference,
        })),
        totals: {
          total_sales: totalSales,
          total_returns: totalReturns,
          total_voids: voids.reduce((s, t) => s + t.total, 0),
          net_sales: totalSales - totalReturns,
          total_tax: totalTax,
          total_discounts: totalDiscounts,
          total_tips: totalTips,
          transaction_count: completedSales.length,
          void_count: voids.length,
          return_count: returns.length,
          avg_transaction: completedSales.length > 0 ? totalSales / completedSales.length : 0,
        },
        payment_breakdown: Array.from(paymentMap.entries()).map(([method, data]) => ({
          payment_method: method,
          total_amount: data.total,
          transaction_count: data.count,
        })),
        tax_summary: Array.from(taxMap.entries()).map(([rate, data]) => ({
          tax_rate: rate,
          taxable_amount: data.taxable,
          tax_amount: data.tax,
        })),
      };
    },
    enabled: !!currentOrg?.id && !!businessId,
  });
}

/**
 * X-Report: Mid-shift snapshot — client-side implementation.
 */
export function usePOSXReport(shiftId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  return useQuery({
    queryKey: ["pos-x-report", currentOrg?.id, businessId, shiftId],
    queryFn: async (): Promise<XReport | null> => {
      if (!currentOrg?.id || !businessId || !shiftId) return null;

      const { data: shift } = await supabase
        .from("pos_shifts")
        .select("*")
        .eq("id", shiftId)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .single();

      if (!shift) return null;

      const { data: transactions } = await supabase
        .from("pos_transactions")
        .select("id, total, transaction_type, status, tax_amount, discount_amount, tip_amount")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", businessId)
        .eq("shift_id", shiftId);

      if (!transactions) return null;

      const completedSales = transactions.filter(t => t.transaction_type === "sale" && t.status === "completed");
      const returns = transactions.filter(t => t.transaction_type === "return");
      const voids = transactions.filter(t => t.status === "voided");

      const totalSales = completedSales.reduce((s, t) => s + t.total, 0);
      const totalReturns = returns.reduce((s, t) => s + t.total, 0);

      const txIds = completedSales.map(t => t.id);
      const { data: payments } = await supabase
        .from("pos_transaction_payments")
        .select("payment_method, amount")
        .in("transaction_id", txIds);

      const paymentMap = new Map<string, { total: number; count: number }>();
      payments?.forEach(p => {
        if (!paymentMap.has(p.payment_method)) paymentMap.set(p.payment_method, { total: 0, count: 0 });
        paymentMap.get(p.payment_method)!.total += p.amount;
        paymentMap.get(p.payment_method)!.count += 1;
      });

      return {
        shift_id: shiftId,
        shift_number: shift.shift_number,
        opened_at: shift.opened_at,
        status: shift.status,
        opening_cash: shift.opening_cash,
        expected_cash: shift.expected_cash,
        totals: {
          total_sales: totalSales,
          total_returns: totalReturns,
          total_voids: voids.reduce((s, t) => s + t.total, 0),
          net_sales: totalSales - totalReturns,
          total_tax: completedSales.reduce((s, t) => s + (t.tax_amount || 0), 0),
          total_discounts: completedSales.reduce((s, t) => s + (t.discount_amount || 0), 0),
          total_tips: completedSales.reduce((s, t) => s + (t.tip_amount || 0), 0),
          transaction_count: completedSales.length,
          void_count: voids.length,
          return_count: returns.length,
          avg_transaction: completedSales.length > 0 ? totalSales / completedSales.length : 0,
        },
        payment_breakdown: Array.from(paymentMap.entries()).map(([method, data]) => ({
          payment_method: method,
          total_amount: data.total,
          transaction_count: data.count,
        })),
        generated_at: new Date().toISOString(),
      };
    },
    enabled: !!currentOrg?.id && !!businessId && !!shiftId,
  });
}
