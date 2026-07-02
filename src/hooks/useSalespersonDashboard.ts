/**
 * Salesperson Dashboard Hook
 * 
 * Aggregates sales data per salesperson across POS, Invoices, and Sales Orders.
 * Provides metrics: total sales, orders, cash collected, credit outstanding.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";

export interface SalespersonMetrics {
  user_id: string;
  user_email: string;
  total_sales: number;
  total_orders: number;
  invoices_generated: number;
  cash_collected: number;
  credit_issued: number;
  outstanding_receivables: number;
}

interface UseSalespersonDashboardParams {
  dateFrom: string;
  dateTo: string;
  salespersonId?: string;
}

export function useSalespersonDashboard(params: UseSalespersonDashboardParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const branchId = currentBranch?.id ?? null;

  // Fetch invoice-based metrics per salesperson
  const invoiceMetrics = useQuery({
    queryKey: [
      "salesperson-invoices",
      currentOrg?.id,
      currentBusiness?.id,
      branchId,
      params.dateFrom,
      params.dateTo,
      params.salespersonId,
    ],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let query = supabase
        .from("invoices")
        .select("salesperson_id, status, total, amount_paid")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .gte("issue_date", params.dateFrom)
        .lte("issue_date", params.dateTo);

      query = applyBranchFilter(query, branchId);
      if (params.salespersonId) {
        query = query.eq("salesperson_id", params.salespersonId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Fetch POS transaction metrics
  const posMetrics = useQuery({
    queryKey: [
      "salesperson-pos",
      currentOrg?.id,
      currentBusiness?.id,
      branchId,
      params.dateFrom,
      params.dateTo,
      params.salespersonId,
    ],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let query = supabase
        .from("pos_transactions")
        .select("created_by, total, transaction_type")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("transaction_type", "sale")
        .gte("created_at", `${params.dateFrom}T00:00:00`)
        .lte("created_at", `${params.dateTo}T23:59:59`);

      query = applyBranchFilter(query, branchId);
      if (params.salespersonId) {
        query = query.eq("created_by", params.salespersonId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Fetch payments collected per salesperson
  const paymentsMetrics = useQuery({
    queryKey: [
      "salesperson-payments",
      currentOrg?.id,
      currentBusiness?.id,
      branchId,
      params.dateFrom,
      params.dateTo,
      params.salespersonId,
    ],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let query = supabase
        .from("payments")
        .select("amount, created_by, payment_date")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .gte("payment_date", params.dateFrom)
        .lte("payment_date", params.dateTo);

      query = applyBranchFilter(query, branchId);
      if (params.salespersonId) {
        query = query.eq("created_by", params.salespersonId);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Fetch user display names from profiles table
  const userNames = useQuery({
    queryKey: ["salesperson-names"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, email");
      if (error) throw error;
      return data || [];
    },
  });

  // Aggregate metrics
  const aggregateMetrics = (): SalespersonMetrics[] => {
    const metricsMap = new Map<string, SalespersonMetrics>();

    const nameMap = new Map<string, { full_name: string | null; email: string }>();
    for (const u of userNames.data || []) {
      nameMap.set(u.user_id, { full_name: u.full_name, email: u.email });
    }

    const getOrCreate = (userId: string): SalespersonMetrics => {
      if (!metricsMap.has(userId)) {
        const userInfo = nameMap.get(userId);
        metricsMap.set(userId, {
          user_id: userId,
          user_email: userInfo?.full_name || userInfo?.email || userId.slice(0, 8),
          total_sales: 0,
          total_orders: 0,
          invoices_generated: 0,
          cash_collected: 0,
          credit_issued: 0,
          outstanding_receivables: 0,
        });
      }
      return metricsMap.get(userId)!;
    };

    // Process invoices
    for (const inv of invoiceMetrics.data || []) {
      if (!inv.salesperson_id) continue;
      const m = getOrCreate(inv.salesperson_id);
      m.invoices_generated++;
      m.total_sales += inv.total || 0;
      const outstanding = (inv.total || 0) - (inv.amount_paid || 0);
      if (outstanding > 0 && inv.status !== "cancelled" && inv.status !== "draft") {
        m.outstanding_receivables += outstanding;
        m.credit_issued += inv.total || 0;
      }
    }

    // Process POS transactions
    for (const txn of posMetrics.data || []) {
      if (!txn.created_by) continue;
      const m = getOrCreate(txn.created_by);
      m.total_orders++;
      m.total_sales += txn.total || 0;
    }

    // Process payments
    for (const pmt of paymentsMetrics.data || []) {
      if (!pmt.created_by) continue;
      const m = getOrCreate(pmt.created_by);
      m.cash_collected += pmt.amount || 0;
    }

    return Array.from(metricsMap.values());
  };

  const isLoading =
    invoiceMetrics.isLoading || posMetrics.isLoading || paymentsMetrics.isLoading;

  return {
    metrics: aggregateMetrics(),
    isLoading,
    refetch: () => {
      invoiceMetrics.refetch();
      posMetrics.refetch();
      paymentsMetrics.refetch();
    },
  };
}
