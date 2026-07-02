import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { format, subDays } from "date-fns";

export interface ShiftReport {
  shift: {
    id: string;
    shift_number: string;
    opened_at: string;
    closed_at: string | null;
    opening_cash: number;
    expected_cash: number;
    actual_cash: number | null;
    cash_difference: number | null;
    status: string;
  };
  sales: {
    total: number;
    count: number;
    byPaymentMethod: Record<string, number>;
    returns: number;
    returnsCount: number;
    net: number;
  };
  cashMovements: {
    cashIn: number;
    cashOut: number;
    floats: number;
    pickups: number;
  };
  products: Array<{
    name: string;
    quantity: number;
    revenue: number;
  }>;
}

export interface DailySalesData {
  date: string;
  total: number;
  transactions: number;
}

export interface HourlySalesData {
  hour: number;
  total: number;
  transactions: number;
}

export interface POSReportsConsolidationFlag {
  /**
   * True when "All Companies" is selected in an org with >1 active business.
   * UI should render a "Select a Company" panel instead of summed totals.
   */
  requiresConsolidation: boolean;
}

/**
 * Z-Report payload returned by `get_pos_z_report` RPC.
 * Stage-3 added a real `tax_summary` per-rate breakdown for fiscal compliance.
 */
export interface ZReportTaxLine {
  tax_rate: number;
  tax_rate_id: string | null;
  taxable_amount: number;
  tax_amount: number;
  item_count: number;
}

export interface ZReport {
  date: string;
  business_id: string;
  register_id: string | null;
  shifts: Array<Record<string, unknown>>;
  totals: {
    total_sales: number;
    total_returns: number;
    total_voids: number;
    net_sales: number;
    total_tax: number;
    total_discounts: number;
    transaction_count: number;
  };
  payment_breakdown: Array<{
    payment_method: string;
    total_amount: number;
    transaction_count: number;
  }>;
  tax_summary: ZReportTaxLine[];
  generated_at: string;
}

export function usePOSReports(options?: { dateFrom?: string; dateTo?: string; registerId?: string; branchId?: string }) {
  const dateFrom = options?.dateFrom;
  const dateTo = options?.dateTo;
  const registerId = options?.registerId;
  const explicitBranchId = options?.branchId;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const branchId = explicitBranchId !== undefined ? explicitBranchId : currentBranch?.id ?? null;
  // Stage R-Wave-A: if no branch is selected AND the caller is not an
  // overseer, the org-wide reporting RPCs must NOT be invoked. This mirrors
  // the gate in `usePOSRegisters` and prevents branch-scoped operators from
  // accidentally fanning out to sister-company / sister-branch totals.
  const reportsEnabled = !!currentOrg?.id && !!currentBusiness?.id
    && (branchId !== null || canOversee);

  // Consolidation gate (D6): when no business is selected and the org has >1 business,
  // POS revenue must NOT be summed across legal entities.
  const { data: requiresConsolidation = false } = useQuery({
    queryKey: ["pos-reports-consolidation-gate", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || currentBusiness?.id) return false;
      const { count } = await supabase
        .from("businesses")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      return (count ?? 0) > 1;
    },
    enabled: !!currentOrg?.id,
  });

  // Get shift report (X or Z report) — uses server-side aggregation RPC
  const getShiftReport = async (shiftId: string): Promise<ShiftReport> => {
    const { data, error } = await supabase.rpc("get_pos_shift_report_summary" as any, {
      _shift_id: shiftId,
    });

    if (error) throw error;

    const result = data as any;
    if (result?.error) throw new Error(result.error);

    return {
      shift: {
        id: result.shift.id,
        shift_number: result.shift.shift_number,
        opened_at: result.shift.opened_at,
        closed_at: result.shift.closed_at,
        opening_cash: Number(result.shift.opening_cash),
        expected_cash: Number(result.shift.expected_cash),
        actual_cash: result.shift.actual_cash != null ? Number(result.shift.actual_cash) : null,
        cash_difference: result.shift.cash_difference != null ? Number(result.shift.cash_difference) : null,
        status: result.shift.status,
      },
      sales: {
        total: Number(result.sales.total),
        count: Number(result.sales.count),
        byPaymentMethod: result.sales.by_payment_method || {},
        returns: Number(result.sales.returns),
        returnsCount: Number(result.sales.returns_count),
        net: Number(result.sales.net),
      },
      cashMovements: {
        cashIn: Number(result.cash_movements.cash_in),
        cashOut: Number(result.cash_movements.cash_out),
        floats: Number(result.cash_movements.floats),
        pickups: Number(result.cash_movements.pickups),
      },
      products: Array.isArray(result.products)
        ? result.products.map((p: any) => ({ name: p.name, quantity: Number(p.quantity), revenue: Number(p.revenue) }))
        : [],
    };
  };

  // Daily sales — server-side aggregation via RPC
  const { data: dailySales = [], isLoading: isDailySalesLoading } = useQuery({
    queryKey: ["pos-daily-sales", currentOrg?.id, currentBusiness?.id, dateFrom, dateTo, registerId, branchId],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const startDate = dateFrom || format(subDays(new Date(), 30), "yyyy-MM-dd");
      const endDate = dateTo || format(new Date(), "yyyy-MM-dd");

      const { data, error } = await supabase.rpc(
        "get_pos_daily_sales" as any,
        {
          p_organization_id: currentOrg.id,
          p_business_id: currentBusiness.id,
          p_date_from: startDate,
          p_date_to: endDate,
          p_register_id: (registerId && registerId !== "all") ? registerId : null,
          p_branch_id: branchId && branchId !== "all" ? branchId : null,
        } as any
      );

      if (error) throw error;

      return ((data as any[]) || []).map((row: any) => ({
        date: row.sale_date,
        total: Number(row.total_amount),
        transactions: Number(row.transaction_count),
      })) as DailySalesData[];
    },
    enabled: reportsEnabled && !requiresConsolidation,
  });

  // Hourly sales — server-side aggregation via RPC
  const { data: hourlySales = [], isLoading: isHourlySalesLoading } = useQuery({
    queryKey: ["pos-hourly-sales", currentOrg?.id, currentBusiness?.id, registerId, branchId],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const today = format(new Date(), "yyyy-MM-dd");

      const { data, error } = await supabase.rpc(
        "get_pos_hourly_sales" as any,
        {
          p_organization_id: currentOrg.id,
          p_business_id: currentBusiness.id,
          p_date: today,
          p_register_id: (registerId && registerId !== "all") ? registerId : null,
          p_branch_id: branchId && branchId !== "all" ? branchId : null,
        } as any
      );

      if (error) throw error;

      const hourMap: Record<number, { total: number; count: number }> = {};
      ((data as any[]) || []).forEach((row: any) => {
        hourMap[row.sale_hour] = { total: Number(row.total_amount), count: Number(row.transaction_count) };
      });

      return Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        total: hourMap[i]?.total || 0,
        transactions: hourMap[i]?.count || 0,
      })) as HourlySalesData[];
    },
    enabled: reportsEnabled && !requiresConsolidation,
  });

  // Top selling products — server-side aggregation via RPC
  const { data: topProducts = [], isLoading: isTopProductsLoading } = useQuery({
    queryKey: ["pos-top-products", currentOrg?.id, currentBusiness?.id, dateFrom, dateTo, registerId, branchId],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const startDate = dateFrom || format(subDays(new Date(), 30), "yyyy-MM-dd");
      const endDate = dateTo || format(new Date(), "yyyy-MM-dd");

      const { data, error } = await supabase.rpc(
        "get_pos_top_products" as any,
        {
          p_organization_id: currentOrg.id,
          p_business_id: currentBusiness.id,
          p_date_from: startDate,
          p_date_to: endDate,
          p_register_id: (registerId && registerId !== "all") ? registerId : null,
          p_limit: 10,
          p_branch_id: branchId && branchId !== "all" ? branchId : null,
        } as any
      );

      if (error) throw error;

      return ((data as any[]) || []).map((row: any) => ({
        name: row.product_name,
        quantity: Number(row.total_quantity),
        revenue: Number(row.total_revenue),
      }));
    },
    enabled: reportsEnabled && !requiresConsolidation,
  });

  return {
    getShiftReport,
    dailySales,
    isDailySalesLoading,
    hourlySales,
    isHourlySalesLoading,
    topProducts,
    isTopProductsLoading,
    requiresConsolidation,
  };
}

/**
 * Fetch the per-day Z-Report for the current business (and optional register).
 * Stage-3: surfaces the new `tax_summary` array so VAT/GST jurisdictions get
 * a fiscal-compliant per-rate breakdown (taxable amount, tax amount, item count).
 */
export function useZReport(options: { date?: string; registerId?: string | null }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const date = options.date ?? format(new Date(), "yyyy-MM-dd");
  const registerId = options.registerId ?? null;

  return useQuery({
    queryKey: ["pos-z-report", currentOrg?.id, currentBusiness?.id, date, registerId],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async (): Promise<ZReport> => {
      const { data, error } = await supabase.rpc("get_pos_z_report" as any, {
        p_organization_id: currentOrg!.id,
        p_business_id: currentBusiness!.id,
        p_date: date,
        p_register_id: registerId,
      } as any);
      if (error) throw error;
      return data as unknown as ZReport;
    },
    staleTime: 30_000,
  });
}
