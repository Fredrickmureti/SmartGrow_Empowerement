/**
 * Execution telemetry — Phase 7.
 *
 * Every number here is DERIVED from `wms_task_events`, the append-only
 * execution ledger. There are no counters, no denormalised columns and
 * no client-side aggregation of task rows: the ledger is the single
 * source of truth, so throughput, dwell time, exception rate and
 * lease-loss (reap) rate cannot drift from what operators actually did.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface TaskTelemetryByType {
  task_type: string;
  tasks: number;
  completed: number;
  exception_rate: number | null;
  reap_rate: number | null;
  avg_wait_seconds: number | null;
  avg_execution_seconds: number | null;
}

export interface TaskTelemetryByOperator {
  operator_id: string;
  completed: number;
  avg_execution_seconds: number | null;
  exceptions: number;
}

export interface TaskTelemetry {
  warehouse_id: string;
  from: string;
  to: string;
  totals: {
    events: number;
    tasks_touched: number;
    completed: number;
    cancelled: number;
    exceptions: number;
    active_operators: number;
  };
  by_type: TaskTelemetryByType[];
  by_operator: TaskTelemetryByOperator[];
}

export function useTaskTelemetry(warehouseId: string | undefined, days: number) {
  return useQuery({
    queryKey: ["wms-task-telemetry", warehouseId, days],
    enabled: !!warehouseId,
    queryFn: async () => {
      const from = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await supabase.rpc("wms_task_telemetry", {
        p_warehouse_id: warehouseId!,
        p_from: from,
        p_to: new Date().toISOString(),
      });
      if (error) throw error;
      return data as unknown as TaskTelemetry;
    },
  });
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
