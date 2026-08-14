/**
 * Labour — the operator's own view of themselves.
 *
 * Everything here is self-scoped and server-enforced: the RPCs resolve the
 * operator from `auth.uid()`, so a handheld can never clock, claim or read
 * performance on behalf of somebody else. The client passes a warehouse and
 * an intent; the database decides whether that intent is legal.
 *
 * Shift state is the ONLY writer of non-task labour time (ADR 0101 / WLM
 * Phase F): `on_shift` opens idle, `break` opens break, `off_shift` closes
 * whatever is open, and task activity flips the operator to `executing`
 * automatically via trigger. The UI therefore never invents a time entry.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { labourErrorMessage } from "./labourErrors";
import { LABOUR_KEYS, type WmsTaskType } from "./useLabourOperators";

export type OperatorStatus = "off_shift" | "on_shift" | "break" | "executing";

export interface MyOperator {
  id: string;
  business_id: string;
  organization_id: string;
  warehouse_id: string;
  user_id: string | null;
  operator_code: string | null;
  status: OperatorStatus;
  status_changed_at: string;
  max_concurrent_tasks: number;
  equipment_classes: string[];
  home_zone_id: string | null;
  is_active: boolean;
}

export interface MyPerformanceRow {
  day: string;
  tasks_completed: number;
  earned_seconds: number;
  direct_seconds: number;
  indirect_seconds: number;
  idle_seconds: number;
  true_utilisation: number | null;
}

export const MY_SHIFT_KEYS = {
  operator: ["wms", "labour", "my-operator"] as const,
  performance: ["wms", "labour", "my-performance"] as const,
  tasks: ["wms", "labour", "my-tasks"] as const,
};

/** The caller's operator record in a warehouse, or null if not enrolled. */
export function useMyOperator(warehouseId: string | undefined) {
  return useQuery({
    queryKey: [...MY_SHIFT_KEYS.operator, warehouseId ?? "none"],
    enabled: !!warehouseId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wms_my_operator", {
        _warehouse_id: warehouseId!,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as MyOperator | null;
    },
  });
}

/** Today's productivity for the caller only — no supervisor permission needed. */
export function useMyPerformance(warehouseId: string | undefined, days = 1) {
  return useQuery({
    queryKey: [...MY_SHIFT_KEYS.performance, warehouseId ?? "none", days],
    enabled: !!warehouseId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wms_my_performance", {
        _warehouse_id: warehouseId!,
        _days: days,
      });
      if (error) throw error;
      return (data ?? []) as unknown as MyPerformanceRow[];
    },
  });
}

export interface MyTaskRow {
  id: string;
  task_type: WmsTaskType;
  state: string;
  priority: number | null;
  quantity: number | null;
  sla_at: string | null;
  warehouse_id: string | null;
}

/** Tasks the caller currently holds — the working set, not the whole queue. */
export function useMyOpenTasks(warehouseId: string | undefined) {
  return useQuery({
    queryKey: [...MY_SHIFT_KEYS.tasks, warehouseId ?? "none"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (!uid) return [];
      let q = supabase
        .from("wms_tasks")
        .select("id, task_type, state, priority, quantity, sla_at, warehouse_id")
        .eq("assignee_user_id", uid)
        .in("state", ["claimed", "in_progress", "paused", "resumed"])
        .order("priority", { ascending: false })
        .limit(50);
      if (warehouseId) q = q.eq("warehouse_id", warehouseId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as MyTaskRow[];
    },
  });
}

/** Shift clock, claim-next and indirect-time logging. */
export function useShiftActions(warehouseId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: MY_SHIFT_KEYS.operator });
    qc.invalidateQueries({ queryKey: MY_SHIFT_KEYS.performance });
    qc.invalidateQueries({ queryKey: MY_SHIFT_KEYS.tasks });
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.board });
    qc.invalidateQueries({ queryKey: LABOUR_KEYS.queue });
  };

  const clock = useMutation({
    mutationFn: async ({
      status,
      notes,
    }: {
      status: Exclude<OperatorStatus, "executing">;
      notes?: string;
    }) => {
      if (!warehouseId) throw new Error("Pick a warehouse first");
      const { error } = await supabase.rpc("wms_operator_clock", {
        _warehouse_id: warehouseId,
        _status: status,
        _notes: notes ?? undefined,
      });
      if (error) throw error;
      return status;
    },
    onSuccess: (status) => {
      toast.success(
        status === "on_shift"
          ? "Clocked on"
          : status === "break"
            ? "On break"
            : "Clocked off",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const claimNext = useMutation({
    mutationFn: async (taskTypes?: WmsTaskType[]) => {
      if (!warehouseId) throw new Error("Pick a warehouse first");
      const { data, error } = await supabase.rpc("wms_claim_next_task", {
        _warehouse_id: warehouseId,
        ...(taskTypes && taskTypes.length ? { _task_types: taskTypes } : {}),
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as { id: string; task_type: WmsTaskType } | null;
    },
    onSuccess: (task) => {
      if (!task) toast.info("Nothing available that you are eligible for");
      else toast.success(`Claimed ${task.task_type} ${task.id.slice(0, 8)}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  const logIndirect = useMutation({
    mutationFn: async ({
      category,
      minutes,
      notes,
    }: {
      category: "indirect" | "travel" | "training" | "meeting" | "maintenance";
      minutes: number;
      notes?: string;
    }) => {
      if (!warehouseId) throw new Error("Pick a warehouse first");
      const { error } = await supabase.rpc("wms_log_labour_entry", {
        _warehouse_id: warehouseId,
        _category: category,
        _seconds: Math.round(minutes * 60),
        _notes: notes ?? undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Time logged");
      invalidate();
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e)),
  });

  return { clock, claimNext, logIndirect };
}
