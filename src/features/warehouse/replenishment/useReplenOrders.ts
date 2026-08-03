/**
 * Replenishment order data access (ADR 0108).
 *
 * Orders are the *plan* aggregate; tasks are the work. Reads go through
 * PostgREST (RLS-scoped); every state write goes through
 * `wms_transition_replen_order` with optimistic concurrency — pages never
 * `.update({ state })` on `wms_replen_orders`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";

export type ReplenOrderState =
  | "planned" | "approved" | "dispatched" | "in_progress" | "completed" | "short" | "cancelled";

export interface ReplenOrderRow {
  id: string;
  state: ReplenOrderState;
  priority: number;
  requested_qty: number;
  moved_qty: number;
  reserved_qty: number;
  reason_code: string;
  lot_number: string | null;
  due_at: string | null;
  created_at: string;
  row_version: number;
  decision_trace: Json;
  rule_id: string | null;
  task_id: string | null;
  product?: { name: string; sku: string | null } | null;
  pick_loc?: { code: string } | null;
  source_loc?: { code: string } | null;
  rule?: { scope: string; strategy: string; priority: number } | null;
}

const OPEN_STATES: ReplenOrderState[] = ["planned", "approved", "dispatched", "in_progress"];

export function useReplenOrders(businessId?: string | null, warehouseFilter = "all") {
  return useQuery({
    queryKey: ["wms-replen-orders", businessId, warehouseFilter],
    enabled: !!businessId,
    queryFn: async () => {
      let q = supabase
        .from("wms_replen_orders")
        .select(
          "id,state,priority,requested_qty,moved_qty,reserved_qty,reason_code,lot_number,due_at,created_at,row_version,decision_trace,rule_id,task_id," +
            "product:products(name,sku)," +
            "pick_loc:stock_locations!wms_replen_orders_pick_location_id_fkey(code)," +
            "source_loc:stock_locations!wms_replen_orders_source_location_id_fkey(code)," +
            "rule:wms_replenishment_rules(scope,strategy,priority)",
        )
        .eq("business_id", businessId!)
        .in("state", OPEN_STATES)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(500);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ReplenOrderRow[];
    },
  });
}

export function useTransitionReplenOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { orders: ReplenOrderRow[]; to: ReplenOrderState; reason?: string }) => {
      let ok = 0;
      const failures: string[] = [];
      for (const o of input.orders) {
        const { error } = await supabase.rpc("wms_transition_replen_order", {
          p_order_id: o.id,
          p_to_state: input.to,
          p_expected_version: o.row_version,
          p_reason: input.reason ?? undefined,
        });
        if (error) failures.push(error.message);
        else ok += 1;
      }
      return { ok, failures };
    },
    onSuccess: ({ ok, failures }, vars) => {
      if (ok > 0) toast.success(`${ok} order(s) → ${vars.to}`);
      if (failures.length) toast.error(failures[0]);
      qc.invalidateQueries({ queryKey: ["wms-replen-orders"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms_tasks"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not update the replenishment order"),
  });
}
