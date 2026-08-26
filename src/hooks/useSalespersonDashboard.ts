/**
 * Salesperson Performance — thin client over the canonical server projection.
 *
 * All aggregation, attribution and reversal handling lives in
 * `get_salesperson_performance`. The browser owns no business logic here:
 * revenue comes from posted invoices, credit from posted credit notes,
 * cash from `payment_allocations`, receivables from `finance_ar_open_items`,
 * and POS only where a sale never became an invoice (so a single commercial
 * transaction is never counted twice).
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export interface SalespersonMetrics {
  salesperson_id: string;
  salesperson_name: string;
  /** Posted invoice value, invoice issue_date basis. */
  gross_invoiced: number;
  /** Posted credit notes reversing this salesperson's invoices. */
  credit_notes_value: number;
  /** gross_invoiced − credit_notes_value. */
  net_revenue: number;
  invoice_count: number;
  orders_booked: number;
  orders_value: number;
  /** Allocated, non-voided cash against this salesperson's invoices. */
  cash_collected: number;
  /** Open receivable position as of today (canonical AR projection). */
  outstanding: number;
  overdue_amount: number;
  /** POS sales with no invoice — reported separately, never folded into revenue. */
  pos_sales_value: number;
  pos_sales_count: number;
  has_foreign_currency: boolean;
  /**
   * Documents excluded from every total above because no conversion evidence
   * exists (foreign currency, no rate stamped on the document). Reported so a
   * gap is visible instead of being valued 1:1.
   */
  unconvertible_document_count: number;
}

/** Which underlying documents a metric is made of. */
export type SalespersonMetricKey =
  | "revenue"
  | "credit"
  | "cash"
  | "outstanding"
  | "orders"
  | "pos";

export interface SalespersonDocument {
  document_id: string;
  document_kind: string;
  document_number: string | null;
  document_date: string | null;
  contact_id: string | null;
  contact_name: string | null;
  /** null when the document has no conversion evidence — never shown as 1:1. */
  amount: number | null;
  status: string | null;
}

interface UseSalespersonDashboardParams {
  dateFrom: string;
  dateTo: string;
}

export function useSalespersonDashboard(params: UseSalespersonDashboardParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const branchId = currentBranch?.id ?? null;

  const query = useQuery({
    queryKey: [
      "salesperson-performance",
      currentOrg?.id,
      currentBusiness?.id,
      branchId,
      params.dateFrom,
      params.dateTo,
    ],
    queryFn: async (): Promise<SalespersonMetrics[]> => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase.rpc(
        "get_salesperson_performance" as never,
        {
          p_org_id: currentOrg.id,
          p_business_id: currentBusiness?.id ?? null,
          p_branch_id: branchId,
          p_date_from: params.dateFrom,
          p_date_to: params.dateTo,
        } as never,
      );
      if (error) throw error;
      return ((data as unknown as SalespersonMetrics[]) ?? []).map((r) => ({
        ...r,
        gross_invoiced: Number(r.gross_invoiced) || 0,
        credit_notes_value: Number(r.credit_notes_value) || 0,
        net_revenue: Number(r.net_revenue) || 0,
        invoice_count: Number(r.invoice_count) || 0,
        orders_booked: Number(r.orders_booked) || 0,
        orders_value: Number(r.orders_value) || 0,
        cash_collected: Number(r.cash_collected) || 0,
        outstanding: Number(r.outstanding) || 0,
        overdue_amount: Number(r.overdue_amount) || 0,
        pos_sales_value: Number(r.pos_sales_value) || 0,
        pos_sales_count: Number(r.pos_sales_count) || 0,
        unconvertible_document_count: Number(r.unconvertible_document_count) || 0,
      }));
    },
    enabled: !!currentOrg?.id,
  });

  return {
    metrics: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

/** Lineage: the documents behind one salesperson's metric for the period. */
export function useSalespersonDocuments(args: {
  salespersonId: string | null;
  metric: SalespersonMetricKey | null;
  dateFrom: string;
  dateTo: string;
}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const branchId = currentBranch?.id ?? null;

  return useQuery({
    queryKey: [
      "salesperson-performance-documents",
      currentOrg?.id,
      currentBusiness?.id,
      branchId,
      args.salespersonId,
      args.metric,
      args.dateFrom,
      args.dateTo,
    ],
    queryFn: async (): Promise<SalespersonDocument[]> => {
      if (!currentOrg?.id || !args.salespersonId || !args.metric) return [];
      const { data, error } = await supabase.rpc(
        "get_salesperson_performance_documents" as never,
        {
          p_org_id: currentOrg.id,
          p_salesperson_id: args.salespersonId,
          p_metric: args.metric,
          p_business_id: currentBusiness?.id ?? null,
          p_branch_id: branchId,
          p_date_from: args.dateFrom,
          p_date_to: args.dateTo,
        } as never,
      );
      if (error) throw error;
      return ((data as unknown as SalespersonDocument[]) ?? []).map((d) => ({
        ...d,
        amount: d.amount === null || d.amount === undefined ? null : Number(d.amount),
      }));
    },
    enabled: !!currentOrg?.id && !!args.salespersonId && !!args.metric,
  });
}
