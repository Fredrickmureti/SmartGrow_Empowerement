import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";

export interface POSDashboardStats {
  todaySales: number;
  todayTransactions: number;
  averageBasket: number;
  todayReturns: number;
  paymentBreakdown: Array<{ method: string; amount: number }>;
  /**
   * True when the user is viewing "All Companies" inside an org with >1 active business.
   * UI must render a "Select a Company" panel instead of misleading summed totals.
   */
  requiresConsolidation?: boolean;
}

export interface POSDashboardScope {
  type: "branch" | "company";
  label: string;
}

const emptyStats: POSDashboardStats = {
  todaySales: 0,
  todayTransactions: 0,
  averageBasket: 0,
  todayReturns: 0,
  paymentBreakdown: [],
};

export function usePOSDashboardStats() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const today = new Date().toISOString().split("T")[0];
  const branchId = currentBranch?.id ?? null;
  const scope: POSDashboardScope = branchId
    ? { type: "branch", label: `Branch: ${currentBranch?.name ?? "Selected branch"}` }
    : { type: "company", label: "Company-wide" };

  const { data: stats, isLoading } = useQuery({
    queryKey: ["pos-dashboard-stats", currentOrg?.id, currentBusiness?.id, branchId, today],
    queryFn: async (): Promise<POSDashboardStats> => {
      if (!currentOrg?.id || !currentBusiness?.id) return emptyStats;

      // Consolidation gate (D6): block cross-business summation
      if (!currentBusiness?.id) {
        const { count } = await supabase
          .from("businesses")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id)
          .eq("is_active", true);
        if ((count ?? 0) > 1) {
          return { ...emptyStats, requiresConsolidation: true };
        }
      }

      const { data, error } = await supabase.rpc("get_pos_dashboard_stats" as any, {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _date: today,
        _branch_id: branchId,
      } as any);

      if (error) {
        console.error("Dashboard stats RPC error:", error);
        return emptyStats;
      }

      const result = data as any;
      return {
        todaySales: Number(result?.today_sales ?? 0),
        todayTransactions: Number(result?.today_transactions ?? 0),
        averageBasket: Number(result?.average_basket ?? 0),
        todayReturns: Number(result?.today_returns ?? 0),
        paymentBreakdown: Array.isArray(result?.payment_breakdown)
          ? result.payment_breakdown.map((p: any) => ({ method: p.method, amount: Number(p.amount) }))
          : [],
      };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    refetchInterval: 60000,
  });

  return { stats: stats ?? emptyStats, isLoading, scope };
}
