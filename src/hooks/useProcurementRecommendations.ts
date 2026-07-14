import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export type RecUrgency = "stockout" | "critical" | "low" | "planned";
export type RecStatus = "open" | "snoozed" | "dismissed" | "actioned";

export interface ProcurementRecommendation {
  id: string;
  run_id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  product_id: string;
  on_hand: number;
  reserved: number;
  incoming: number;
  velocity_per_week: number;
  safety_stock: number;
  lead_time_days: number;
  net_requirement: number;
  suggested_qty: number;
  suggested_source: "buy" | "transfer" | "manufacture";
  preferred_vendor_id: string | null;
  urgency: RecUrgency;
  needed_by: string | null;
  explanation: Record<string, number | string | null>;
  status: RecStatus;
  created_at: string;
  product?: { id: string; name: string; sku: string | null } | null;
  vendor?: { id: string; name: string } | null;
  branch?: { id: string; name: string } | null;
}

export interface ReplenishmentRun {
  id: string;
  business_id: string | null;
  branch_id: string | null;
  run_type: "manual" | "scheduled" | "event";
  status: "running" | "completed" | "failed";
  recommendations_created: number;
  stockouts: number;
  critical: number;
  low: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

/**
 * Reads open procurement recommendations for the active business/branch.
 * The `run_replenishment_planning` RPC (session-authenticated) is the
 * only writer; this hook is read-only + status transitions.
 */
export function useProcurementRecommendations() {
  const qc = useQueryClient();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const organizationId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const branchId = currentBranch?.id ?? null;

  const recsQuery = useQuery({
    queryKey: ["procurement-recommendations", organizationId, businessId, branchId],
    enabled: !!organizationId && !!businessId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("procurement_recommendations")
        .select(
          `*,
           product:products!product_id(id,name,sku),
           vendor:contacts!preferred_vendor_id(id,name),
           branch:branches!branch_id(id,name)`,
        )
        .eq("business_id", businessId)
        .eq("status", "open")
        .order("urgency", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(500);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ProcurementRecommendation[];
    },
  });

  const runsQuery = useQuery({
    queryKey: ["replenishment-runs", organizationId, businessId],
    enabled: !!organizationId && !!businessId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("replenishment_runs")
        .select("*")
        .eq("business_id", businessId)
        .order("started_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as ReplenishmentRun[];
    },
  });

  const runPlanning = useMutation({
    mutationFn: async () => {
      if (!businessId) throw new Error("Select a business first");
      const { data, error } = await (supabase as any).rpc("run_replenishment_planning", {
        p_business_id: businessId,
        p_branch_id: branchId,
        p_trigger_type: "manual",
      });
      if (error) throw error;
      return data as {
        run_id: string;
        recommendations_created: number;
        stockouts: number;
        critical: number;
        low: number;
      };
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["procurement-recommendations"] }),
        qc.invalidateQueries({ queryKey: ["replenishment-runs"] }),
      ]);
    },
  });

  const setStatus = useMutation({
    mutationFn: async (args: { id: string; status: RecStatus }) => {
      const { error } = await (supabase as any)
        .from("procurement_recommendations")
        .update({ status: args.status })
        .eq("id", args.id);
      if (error) throw error;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["procurement-recommendations"] }),
  });

  return {
    recommendations: recsQuery.data ?? [],
    runs: runsQuery.data ?? [],
    isLoading: recsQuery.isLoading || runsQuery.isLoading,
    error: recsQuery.error || runsQuery.error,
    runPlanning,
    setStatus,
  };
}