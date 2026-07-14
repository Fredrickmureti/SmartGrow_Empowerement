import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export type RecUrgency = "stockout" | "critical" | "low" | "planned";
export type RecStatus =
  | "open"
  | "snoozed"
  | "dismissed"
  | "actioned"
  | "in_review"
  | "approved"
  | "executing"
  | "fulfilled"
  | "cancelled"
  | "merged";

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
  snooze_until: string | null;
  assignee_id: string | null;
  linked_po_id: string | null;
  linked_transfer_id: string | null;
  linked_mo_id: string | null;
  edited_qty: number | null;
  override_reason: string | null;
  merged_into_id: string | null;
  actioned_at: string | null;
  actioned_by: string | null;
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

export interface RecommendationEvent {
  id: string;
  recommendation_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  payload: Record<string, unknown>;
  note: string | null;
  created_at: string;
}

const OPEN_STATUSES: RecStatus[] = ["open", "in_review", "approved", "snoozed"];

/**
 * Reads recommendations for the active business/branch and exposes the
 * Phase 1 lifecycle actions (snooze/assign/edit/convert/merge/dismiss).
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
        .in("status", OPEN_STATUSES)
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

  const recsKey = ["procurement-recommendations"] as const;
  const invalidateRecs = () => qc.invalidateQueries({ queryKey: recsKey });

  /**
   * Optimistically patch every cached recommendations list. The recs list is
   * keyed by (org, business, branch) — we mutate every variant so the row
   * transitions (approve, snooze, dismiss, edit) feel instant regardless of
   * which branch scope is active.
   */
  function patchCachedRec(id: string, patch: Partial<ProcurementRecommendation>) {
    const snapshots: Array<[readonly unknown[], ProcurementRecommendation[] | undefined]> = [];
    qc.getQueriesData<ProcurementRecommendation[]>({ queryKey: recsKey }).forEach(([key, data]) => {
      snapshots.push([key, data]);
      if (!data) return;
      qc.setQueryData<ProcurementRecommendation[]>(key, data.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    });
    return snapshots;
  }
  function restoreCachedRecs(snapshots: Array<[readonly unknown[], ProcurementRecommendation[] | undefined]>) {
    snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
  }

  const setStatus = useMutation({
    mutationFn: async (args: { id: string; status: RecStatus }) => {
      const { error } = await (supabase as any)
        .from("procurement_recommendations")
        .update({ status: args.status })
        .eq("id", args.id);
      if (error) throw error;
    },
    onMutate: async (args) => ({ snapshots: patchCachedRec(args.id, { status: args.status }) }),
    onError: (_e, _a, ctx) => ctx && restoreCachedRecs(ctx.snapshots),
    onSettled: invalidateRecs,
  });

  const snooze = useMutation({
    mutationFn: async (args: { id: string; until: Date; note?: string }) => {
      const { error } = await (supabase as any).rpc("snooze_procurement_recommendation", {
        p_rec_id: args.id,
        p_snooze_until: args.until.toISOString(),
        p_note: args.note ?? null,
      });
      if (error) throw error;
    },
    onMutate: async (args) => ({
      snapshots: patchCachedRec(args.id, { status: "snoozed", snooze_until: args.until.toISOString() }),
    }),
    onError: (_e, _a, ctx) => ctx && restoreCachedRecs(ctx.snapshots),
    onSettled: invalidateRecs,
  });

  const assign = useMutation({
    mutationFn: async (args: { id: string; assigneeId: string | null }) => {
      const { error } = await (supabase as any).rpc("assign_procurement_recommendation", {
        p_rec_id: args.id,
        p_assignee: args.assigneeId,
      });
      if (error) throw error;
    },
    onMutate: async (args) => ({ snapshots: patchCachedRec(args.id, { assignee_id: args.assigneeId }) }),
    onError: (_e, _a, ctx) => ctx && restoreCachedRecs(ctx.snapshots),
    onSettled: invalidateRecs,
  });

  const editQty = useMutation({
    mutationFn: async (args: { id: string; qty: number; reason: string }) => {
      const { error } = await (supabase as any).rpc("edit_procurement_recommendation_qty", {
        p_rec_id: args.id,
        p_qty: args.qty,
        p_reason: args.reason,
      });
      if (error) throw error;
    },
    onMutate: async (args) => ({
      snapshots: patchCachedRec(args.id, { edited_qty: args.qty, override_reason: args.reason }),
    }),
    onError: (_e, _a, ctx) => ctx && restoreCachedRecs(ctx.snapshots),
    onSettled: invalidateRecs,
  });

  const convertToPo = useMutation({
    mutationFn: async (args: {
      id: string;
      vendorId?: string | null;
      qty?: number | null;
      notes?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc("convert_recommendation_to_po", {
        p_rec_id: args.id,
        p_vendor_id: args.vendorId ?? null,
        p_qty: args.qty ?? null,
        p_notes: args.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: async () => {
      await Promise.all([
        invalidateRecs(),
        qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
      ]);
    },
  });

  const convertToTransfer = useMutation({
    mutationFn: async (args: {
      id: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      qty?: number | null;
      notes?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc(
        "convert_recommendation_to_transfer",
        {
          p_rec_id: args.id,
          p_from_warehouse_id: args.fromWarehouseId,
          p_to_warehouse_id: args.toWarehouseId,
          p_qty: args.qty ?? null,
          p_notes: args.notes ?? null,
        },
      );
      if (error) throw error;
      return data as string;
    },
    onSuccess: async () => {
      await Promise.all([
        invalidateRecs(),
        qc.invalidateQueries({ queryKey: ["stock-transfers"] }),
      ]);
    },
  });

  const mergeRecs = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data, error } = await (supabase as any).rpc(
        "merge_procurement_recommendations",
        { p_ids: ids },
      );
      if (error) throw error;
      return data as string;
    },
    onSuccess: invalidateRecs,
  });

  return {
    recommendations: recsQuery.data ?? [],
    runs: runsQuery.data ?? [],
    isLoading: recsQuery.isLoading || runsQuery.isLoading,
    error: recsQuery.error || runsQuery.error,
    runPlanning,
    setStatus,
    snooze,
    assign,
    editQty,
    convertToPo,
    convertToTransfer,
    mergeRecs,
  };
}

/** Audit trail for a single recommendation. */
export function useRecommendationEvents(recId: string | null) {
  return useQuery({
    queryKey: ["procurement-recommendation-events", recId],
    enabled: !!recId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("procurement_recommendation_events")
        .select("*")
        .eq("recommendation_id", recId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as RecommendationEvent[];
    },
  });
}
