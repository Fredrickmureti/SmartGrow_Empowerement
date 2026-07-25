import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { routeApproval } from "@/lib/governance/approvalEngine";

/**
 * Maps a raw RPC error string onto a planner-friendly message. Any SQL
 * exception raised by the procurement RPCs bubbles up as `error.message`.
 * We normalise the well-known ones so toasts don't read like a stack trace.
 */
export function humanizeRecError(raw: string | undefined | null): string {
  const m = (raw ?? "").toLowerCase();
  if (!m) return "Something went wrong. Please try again.";
  if (m.includes("must share the same business, product and preferred vendor"))
    return "Selected recommendations must share the same product and preferred vendor to be merged.";
  if (m.includes("at least two recommendations required"))
    return "Select at least two recommendations to merge.";
  if (m.includes("already linked to purchase order"))
    return "This recommendation already has a linked purchase order.";
  if (m.includes("already linked to transfer"))
    return "This recommendation already has a linked stock transfer.";
  if (m.includes("recommendation has no preferred vendor") || m.includes("a vendor is required"))
    return "Pick a vendor before creating a purchase order.";
  if (m.includes("from and to warehouses must differ"))
    return "Source and destination warehouses must be different.";
  if (m.includes("access denied")) return "You don't have access to this record.";
  if (m.includes("recommendation not found")) return "This recommendation no longer exists.";
  if (m.includes("quantity must be > 0")) return "Quantity must be greater than zero.";
  return raw!;
}


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
  warehouse_id: string | null;
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
  approval_request_id: string | null;
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
        .limit(2000);
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

  // Realtime — planners get near-live updates when other users change a
  // recommendation or when a scheduled run finishes without needing to
  // refresh. See migration enabling the supabase_realtime publication for
  // procurement_recommendations + replenishment_runs.
  useEffect(() => {
    if (!businessId) return;
    const channel = supabase
      .channel(`replenishment-workspace-${businessId}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "procurement_recommendations", filter: `business_id=eq.${businessId}` },
        () => {
          qc.invalidateQueries({ queryKey: ["procurement-recommendations", organizationId, businessId] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "replenishment_runs", filter: `business_id=eq.${businessId}` },
        () => {
          qc.invalidateQueries({ queryKey: ["replenishment-runs", organizationId, businessId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, organizationId, businessId]);



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

  /**
   * Approve a recommendation through the canonical approval engine.
   *
   * `routeApproval` is the single entry point: the database evaluates the
   * active `approval_rules` for
   * (entity_type='procurement_recommendation', action_key='procurement_recommendation.approve'),
   * materialises the request + step approvers when a rule matches, and
   * returns `null` when policy does not gate this event. A DB trigger
   * mirrors the routed/decided request back onto the recommendation
   * (`in_review` → `approved` / back to `open`). No threshold evaluation
   * happens in the browser — that was bypassable.
   */
  const approveOrRequest = useMutation({
    mutationFn: async (args: {
      id: string;
      suggestedQty: number;
      estimatedCost?: number;
    }): Promise<{ approved: boolean; ruleName?: string }> => {
      const request = await routeApproval({
        actionKey: "procurement_recommendation.approve",
        entityType: "procurement_recommendation",
        entityId: args.id,
        payload: {
          suggested_qty: args.suggestedQty,
          estimated_cost: args.estimatedCost ?? 0,
        },
        context: organizationId ? { organization_id: organizationId } : {},
        businessId: businessId,
      });

      // A request row means policy gated this approval — the trigger has
      // already moved the rec to `in_review`.
      if (request?.id) return { approved: false };

      const { error } = await (supabase as any)
        .from("procurement_recommendations")
        .update({ status: "approved" })
        .eq("id", args.id);
      if (error) throw error;
      return { approved: true };
    },
    onSuccess: invalidateRecs,
  });

  const cancelApproval = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("cancel_procurement_approval", {
        p_rec_id: id,
      });
      if (error) throw error;
    },
    onSuccess: invalidateRecs,
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


  const attachToPo = useMutation({
    mutationFn: async (args: {
      id: string;
      poId: string;
      qty?: number | null;
      notes?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc(
        "attach_recommendation_to_po",
        {
          p_rec_id: args.id,
          p_po_id: args.poId,
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
        qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
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
    approveOrRequest,
    cancelApproval,
    snooze,
    assign,
    editQty,
    convertToPo,
    convertToTransfer,
    attachToPo,
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

/**
 * Per-warehouse on-hand for a product — powers the transfer flow's
 * "recommended source" hint. Returns rows sorted by descending on-hand
 * (surplus warehouses surface first). Only warehouses in the same
 * business as the recommendation are returned.
 */
export function useWarehouseStockForProduct(
  productId: string | null | undefined,
  businessId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["warehouse-stock-for-product", productId, businessId],
    enabled: !!productId && !!businessId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("warehouse_stock")
        .select("warehouse_id, quantity, warehouse:warehouses!warehouse_id(id, name, business_id)")
        .eq("product_id", productId!);
      if (error) throw error;
      const rows = ((data ?? []) as Array<{
        warehouse_id: string;
        quantity: number;
        warehouse: { id: string; name: string; business_id: string | null } | null;
      }>)
        .filter((r) => r.warehouse?.business_id === businessId)
        .map((r) => ({
          warehouseId: r.warehouse_id,
          warehouseName: r.warehouse?.name ?? "Unknown",
          onHand: Number(r.quantity) || 0,
        }))
        .sort((a, b) => b.onHand - a.onHand);
      return rows;
    },
  });
}

/**
 * Renders a single-sentence planner-friendly explanation from a
 * recommendation's numbers. Deliberately non-technical: no formulas,
 * no jargon. Falls back to a neutral sentence when velocity is zero.
 */
export function narrateRecommendation(rec: ProcurementRecommendation): string {
  const available = Math.max(0, Number(rec.on_hand) - Number(rec.reserved));
  const velocityDaily = (Number(rec.velocity_per_week) || 0) / 7;
  const incoming = Number(rec.incoming) || 0;
  const suggested = Number(rec.edited_qty ?? rec.suggested_qty) || 0;
  const lead = Number(rec.lead_time_days) || 0;
  const daysOfCover = velocityDaily > 0 ? Math.floor((available + incoming) / velocityDaily) : null;

  const parts: string[] = [];

  if (rec.urgency === "stockout") {
    parts.push("Already out of stock.");
  } else if (daysOfCover !== null && daysOfCover >= 0) {
    parts.push(
      `Will run out in ${daysOfCover} day${daysOfCover === 1 ? "" : "s"} at the current sell-through rate.`,
    );
  } else {
    parts.push("Below safety stock with no measurable sell-through this month.");
  }

  const velWeekly = Math.round(Number(rec.velocity_per_week) || 0);
  if (velWeekly > 0) {
    parts.push(`28-day velocity is ~${velWeekly}/week.`);
  }

  if (incoming > 0) {
    parts.push(`${Math.round(incoming)} unit${incoming === 1 ? "" : "s"} already on order.`);
  } else {
    parts.push("Nothing is on order today.");
  }

  if (lead > 0) {
    parts.push(`Vendor lead time is ${lead} day${lead === 1 ? "" : "s"}.`);
  }

  if (suggested > 0) {
    const source =
      rec.suggested_source === "manufacture"
        ? "manufacture"
        : rec.suggested_source === "transfer"
          ? "transfer in"
          : "purchase";
    parts.push(`Suggest ${source} ${Math.round(suggested)} units${
      rec.needed_by ? ` by ${new Date(rec.needed_by).toLocaleDateString()}` : ""
    }.`);
  }

  return parts.join(" ");
}

