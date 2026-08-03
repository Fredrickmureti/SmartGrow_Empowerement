/**
 * Cross-dock data layer (aggregate wrapper).
 *
 * Pages never call cross-dock RPCs directly — every lifecycle transition
 * goes through this module so the FSM, optimistic concurrency (row_version)
 * and cache invalidation stay in one place.
 *
 * Writes:
 *   wms_crossdock_approve / _reject / _start_staging / _confirm_staged /
 *   _mark_loaded / _complete / _break / _sweep_expired
 * Reads: wms_crossdock_opportunities, wms_crossdock_rules, wms_crossdock_history
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CrossdockState =
  | "detected"
  | "qualified"
  | "rejected"
  | "approved"
  | "staging"
  | "staged"
  | "loaded"
  | "completed"
  | "expired"
  | "broken"
  | "cancelled";

export const CROSSDOCK_ACTIVE_STATES: CrossdockState[] = [
  "detected",
  "qualified",
  "approved",
  "staging",
  "staged",
  "loaded",
];

export interface CrossdockOpportunity {
  id: string;
  warehouse_id: string;
  grn_id: string | null;
  grn_line_id: string | null;
  receiving_line_id: string | null;
  product_id: string;
  quantity: number;
  demand_type: "sales_order" | "transfer" | "replenishment" | "production";
  demand_doc_id: string | null;
  demand_line_id: string | null;
  sales_order_id: string | null;
  state: CrossdockState;
  score: number | null;
  expires_at: string | null;
  staging_location_id: string | null;
  outbound_dock_id: string | null;
  stage_task_id: string | null;
  load_task_id: string | null;
  reject_reason: string | null;
  break_reason: string | null;
  row_version: number;
  matched_at: string;
  staged_at: string | null;
  loaded_at: string | null;
  completed_at: string | null;
}

export interface CrossdockRule {
  id: string;
  warehouse_id: string | null;
  name: string;
  is_active: boolean;
  priority: number;
  min_shelf_life_days: number | null;
  allow_lot_tracked: boolean;
  allow_serial_tracked: boolean;
  require_qc_pass: boolean;
  min_quantity: number;
  max_quantity: number | null;
  min_hours_to_cutoff: number;
  max_hours_to_cutoff: number;
  require_full_line: boolean;
  auto_approve_score: number | null;
}

export interface CrossdockHistoryRow {
  id: string;
  opportunity_id: string;
  from_state: CrossdockState | null;
  to_state: CrossdockState;
  reason: string | null;
  created_at: string;
}

const OPP_COLUMNS =
  "id,warehouse_id,grn_id,grn_line_id,receiving_line_id,product_id,quantity,demand_type,demand_doc_id,demand_line_id,sales_order_id,state,score,expires_at,staging_location_id,outbound_dock_id,stage_task_id,load_task_id,reject_reason,break_reason,row_version,matched_at,staged_at,loaded_at,completed_at";

export function useCrossdockOpportunities(params: {
  businessId?: string;
  warehouseId?: string;
  states?: CrossdockState[];
}) {
  const { businessId, warehouseId, states } = params;
  return useQuery({
    queryKey: ["wms-crossdock", businessId, warehouseId, states?.join(",")],
    enabled: !!businessId,
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = (supabase.from("wms_crossdock_opportunities") as any)
        .select(OPP_COLUMNS)
        .eq("business_id", businessId)
        .order("score", { ascending: false, nullsFirst: false })
        .order("matched_at", { ascending: false })
        .limit(300);
      if (warehouseId && warehouseId !== "all") q = q.eq("warehouse_id", warehouseId);
      if (states?.length) q = q.in("state", states);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CrossdockOpportunity[];
    },
  });
}

export function useCrossdockRules(businessId?: string) {
  return useQuery({
    queryKey: ["wms-crossdock-rules", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await (supabase.from("wms_crossdock_rules") as any)
        .select(
          "id,warehouse_id,name,is_active,priority,min_shelf_life_days,allow_lot_tracked,allow_serial_tracked,require_qc_pass,min_quantity,max_quantity,min_hours_to_cutoff,max_hours_to_cutoff,require_full_line,auto_approve_score",
        )
        .eq("business_id", businessId)
        .order("priority");
      if (error) throw error;
      return (data ?? []) as CrossdockRule[];
    },
  });
}

export function useCrossdockHistory(opportunityId?: string) {
  return useQuery({
    queryKey: ["wms-crossdock-history", opportunityId],
    enabled: !!opportunityId,
    queryFn: async () => {
      const { data, error } = await (supabase.from("wms_crossdock_history") as any)
        .select("id,opportunity_id,from_state,to_state,reason,created_at")
        .eq("opportunity_id", opportunityId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CrossdockHistoryRow[];
    },
  });
}

type TransitionArgs = {
  id: string;
  rowVersion: number;
  reason?: string;
  outboundDockId?: string | null;
  stagingLocationId?: string | null;
};

/** One mutation surface for every cross-dock lifecycle transition. */
export function useCrossdockTransitions() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
    qc.invalidateQueries({ queryKey: ["wms-crossdock-history"] });
    qc.invalidateQueries({ queryKey: ["wms-tasks"] });
  };

  const run = (
    fn: string,
    label: string,
    args: (a: TransitionArgs) => Record<string, unknown>,
  ) =>
    useMutation({
      mutationFn: async (a: TransitionArgs) => {
        const { error } = await (supabase.rpc as any)(fn, args(a));
        if (error) throw error;
      },
      onSuccess: () => {
        toast.success(label);
        invalidate();
      },
      onError: (e: Error) => toast.error(e.message),
    });

  return {
    approve: run("wms_crossdock_approve", "Cross-dock approved", (a) => ({
      p_opportunity_id: a.id,
      p_row_version: a.rowVersion,
      p_outbound_dock_id: a.outboundDockId ?? null,
      p_staging_location_id: a.stagingLocationId ?? null,
    })),
    reject: run("wms_crossdock_reject", "Cross-dock rejected", (a) => ({
      p_opportunity_id: a.id,
      p_reason: a.reason ?? "Rejected by supervisor",
      p_row_version: a.rowVersion,
    })),
    startStaging: run("wms_crossdock_start_staging", "Move task issued", (a) => ({
      p_opportunity_id: a.id,
      p_row_version: a.rowVersion,
    })),
    confirmStaged: run("wms_crossdock_confirm_staged", "Staged — load task issued", (a) => ({
      p_opportunity_id: a.id,
      p_row_version: a.rowVersion,
    })),
    markLoaded: run("wms_crossdock_mark_loaded", "Marked loaded", (a) => ({
      p_opportunity_id: a.id,
      p_row_version: a.rowVersion,
    })),
    complete: run("wms_crossdock_complete", "Cross-dock completed", (a) => ({
      p_opportunity_id: a.id,
      p_row_version: a.rowVersion,
    })),
    breakFlow: run("wms_crossdock_break", "Cross-dock broken to put-away", (a) => ({
      p_opportunity_id: a.id,
      p_reason: a.reason ?? "Broken on the floor",
      p_row_version: a.rowVersion,
    })),
    cancel: run("cancel_crossdock_opportunity", "Opportunity cancelled", (a) => ({
      p_opportunity_id: a.id,
      p_reason: a.reason ?? "Cancelled from board",
    })),
  };
}

/** Manual supervisor sweep for lapsed windows. */
export function useCrossdockSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase.rpc as any)("wms_crossdock_sweep_expired");
      if (error) throw error;
      return (data as number) ?? 0;
    },
    onSuccess: (n) => {
      toast.success(n ? `${n} opportunity(ies) expired` : "Nothing to expire");
      qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
