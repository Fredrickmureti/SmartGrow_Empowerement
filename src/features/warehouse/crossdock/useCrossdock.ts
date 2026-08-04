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
import { useEffect, useRef } from "react";
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
  /* Enrichment supplied by wms_crossdock_board_view — never written. */
  product_name: string | null;
  product_sku: string | null;
  warehouse_name: string | null;
  dock_code: string | null;
  staging_code: string | null;
  assignee_name: string | null;
  demand_number: string | null;
  customer_name: string | null;
  hours_to_cutoff: number | null;
  savings_estimate: number | null;
}

export interface CrossdockMetrics {
  warehouse_id: string;
  metric_date: string;
  opportunities: number;
  completed: number;
  broken: number;
  expired: number;
  rejected: number;
  success_rate_pct: number | null;
  units_flowed: number;
  touches_avoided: number;
  storage_days_avoided: number;
  avg_dwell_hours: number | null;
  savings_estimate: number;
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
  "id,warehouse_id,grn_id,grn_line_id,receiving_line_id,product_id,quantity,demand_type,demand_doc_id,demand_line_id,sales_order_id,state,score,expires_at,staging_location_id,outbound_dock_id,stage_task_id,load_task_id,reject_reason,break_reason,row_version,matched_at,staged_at,loaded_at,completed_at,savings_estimate,product_name,product_sku,warehouse_name,dock_code,staging_code,assignee_name,demand_number,customer_name,hours_to_cutoff";

/**
 * Board read. Sources the enriched view so the console shows product,
 * customer, dock and operator names instead of UUIDs, and stays live via
 * Realtime on the underlying table (no polling).
 */
export function useCrossdockOpportunities(params: {
  businessId?: string;
  warehouseId?: string;
  states?: CrossdockState[];
}) {
  const { businessId, warehouseId, states } = params;
  const qc = useQueryClient();

  // One Realtime channel per hook instance. The board mounts this hook more
  // than once (filtered board + unfiltered counts), and `supabase.channel()`
  // returns the EXISTING channel for a repeated topic — binding another
  // `postgres_changes` callback to an already-subscribed channel throws
  // "cannot add postgres_changes callbacks ... after subscribe()". A per-mount
  // topic suffix keeps each subscriber isolated.
  const channelIdRef = useRef<string | undefined>(undefined);
  if (!channelIdRef.current) {
    channelIdRef.current = Math.random().toString(36).slice(2, 10);
  }

  useEffect(() => {
    if (!businessId) return;
    const channel = supabase
      .channel(`wms-crossdock-${businessId}-${channelIdRef.current}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "wms_crossdock_opportunities",
          filter: `business_id=eq.${businessId}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
          qc.invalidateQueries({ queryKey: ["wms-crossdock-metrics"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [businessId, qc]);


  return useQuery({
    queryKey: ["wms-crossdock", businessId, warehouseId, states?.join(",")],
    enabled: !!businessId,
    queryFn: async () => {
      let q = (supabase.from("wms_crossdock_board_view") as any)
        .select(OPP_COLUMNS)
        .eq("business_id", businessId)
        .order("expires_at", { ascending: true, nullsFirst: false })
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

/** Cross-dock KPI rollup (last 30 days by default). */
export function useCrossdockMetrics(businessId?: string, warehouseId?: string, days = 30) {
  return useQuery({
    queryKey: ["wms-crossdock-metrics", businessId, warehouseId, days],
    enabled: !!businessId,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      let q = (supabase.from("wms_crossdock_metrics_view") as any)
        .select(
          "warehouse_id,metric_date,opportunities,completed,broken,expired,rejected,success_rate_pct,units_flowed,touches_avoided,storage_days_avoided,avg_dwell_hours,savings_estimate",
        )
        .eq("business_id", businessId)
        .gte("metric_date", since);
      if (warehouseId && warehouseId !== "all") q = q.eq("warehouse_id", warehouseId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CrossdockMetrics[];
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

export type CrossdockAction =
  | "approve"
  | "reject"
  | "startStaging"
  | "confirmStaged"
  | "markLoaded"
  | "complete"
  | "break"
  | "cancel";

export interface CrossdockTransitionArgs {
  action: CrossdockAction;
  id: string;
  rowVersion: number;
  reason?: string;
  outboundDockId?: string | null;
  stagingLocationId?: string | null;
}

const ACTION_MAP: Record<
  CrossdockAction,
  { fn: string; label: string; args: (a: CrossdockTransitionArgs) => Record<string, unknown> }
> = {
  approve: {
    fn: "wms_crossdock_approve",
    label: "Cross-dock approved",
    args: (a) => ({
      p_opportunity_id: a.id,
      p_row_version: a.rowVersion,
      p_outbound_dock_id: a.outboundDockId ?? null,
      p_staging_location_id: a.stagingLocationId ?? null,
    }),
  },
  reject: {
    fn: "wms_crossdock_reject",
    label: "Cross-dock rejected",
    args: (a) => ({
      p_opportunity_id: a.id,
      p_reason: a.reason ?? "Rejected by supervisor",
      p_row_version: a.rowVersion,
    }),
  },
  startStaging: {
    fn: "wms_crossdock_start_staging",
    label: "Move-to-staging task issued",
    args: (a) => ({ p_opportunity_id: a.id, p_row_version: a.rowVersion }),
  },
  confirmStaged: {
    fn: "wms_crossdock_confirm_staged",
    label: "Staged — load task issued",
    args: (a) => ({ p_opportunity_id: a.id, p_row_version: a.rowVersion }),
  },
  markLoaded: {
    fn: "wms_crossdock_mark_loaded",
    label: "Marked loaded",
    args: (a) => ({ p_opportunity_id: a.id, p_row_version: a.rowVersion }),
  },
  complete: {
    fn: "wms_crossdock_complete",
    label: "Cross-dock completed",
    args: (a) => ({ p_opportunity_id: a.id, p_row_version: a.rowVersion }),
  },
  break: {
    fn: "wms_crossdock_break",
    label: "Cross-dock broken back to put-away",
    args: (a) => ({
      p_opportunity_id: a.id,
      p_reason: a.reason ?? "Broken on the floor",
      p_row_version: a.rowVersion,
    }),
  },
  cancel: {
    fn: "cancel_crossdock_opportunity",
    label: "Opportunity cancelled",
    args: (a) => ({ p_opportunity_id: a.id, p_reason: a.reason ?? "Cancelled from board" }),
  },
};

/** One mutation surface for every cross-dock lifecycle transition. */
export function useCrossdockTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: CrossdockTransitionArgs) => {
      const spec = ACTION_MAP[a.action];
      const { error } = await (supabase.rpc as any)(spec.fn, spec.args(a));
      if (error) throw error;
      return spec.label;
    },
    onSuccess: (label) => {
      toast.success(label);
      qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
      qc.invalidateQueries({ queryKey: ["wms-crossdock-history"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Manual supervisor sweep: expires lapsed windows and re-qualifies live
 * plans against current demand (the same pair pg_cron runs on a schedule).
 */
export function useCrossdockSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: expired, error } = await (supabase.rpc as any)("wms_crossdock_sweep_expired");
      if (error) throw error;
      const { data: requalified, error: rqErr } = await (supabase.rpc as any)(
        "wms_crossdock_requalify_sweep",
      );
      if (rqErr) throw rqErr;
      return ((expired as number) ?? 0) + ((requalified as number) ?? 0);
    },
    onSuccess: (n) => {
      toast.success(n ? `${n} plan(s) closed or re-qualified` : "Everything still valid");
      qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
      qc.invalidateQueries({ queryKey: ["wms-crossdock-metrics"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Rules editor writes — cross-dock qualification policy. */
export function useSaveCrossdockRule(businessId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rule: Partial<CrossdockRule> & { id?: string }) => {
      if (rule.id) {
        const { error } = await (supabase.from("wms_crossdock_rules") as any)
          .update(rule)
          .eq("id", rule.id);
        if (error) throw error;
        return "Rule updated";
      }
      const { error } = await (supabase.from("wms_crossdock_rules") as any).insert({
        ...rule,
        business_id: businessId,
      });
      if (error) throw error;
      return "Rule created";
    },
    onSuccess: (label) => {
      toast.success(label);
      qc.invalidateQueries({ queryKey: ["wms-crossdock-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
