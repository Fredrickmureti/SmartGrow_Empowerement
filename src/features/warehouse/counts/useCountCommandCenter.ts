/**
 * useCountCommandCenter / useCountSessionBoard — the ONLY read paths for
 * the cycle-count supervisor console.
 *
 * Both call read-only aggregate RPCs so no warehouse rule (tolerance,
 * accuracy, blind masking) is re-implemented in the client. In
 * particular `get_count_session_board` returns NULL variance figures for
 * a blind session that is still being counted — the same masking
 * `get_count_lines` applies — so the console cannot leak expected
 * quantities to a counter who happens to hold supervisor screens open.
 *
 * Query keys sit under the `wms-count-sessions` prefix so the WMS
 * realtime channel (`useWmsRealtimeSync`) refreshes the console as
 * counters record lines. No polling.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CountSessionBoardRow {
  id: string;
  code: string;
  state: string;
  strategy: string;
  warehouse_id: string | null;
  warehouse_name: string | null;
  is_blind: boolean;
  requires_approval: boolean;
  recount_round: number | null;
  created_at: string;
  posted_at: string | null;
  last_activity_at: string | null;
  line_count: number;
  counted_count: number;
  open_recounts: number;
  unexplained_variances: number;
  /** NULL while a blind session is still being counted. */
  variance_lines: number | null;
  abs_variance_qty: number | null;
  counters: number;
  figures_masked: boolean;
}

export interface OverdueSchedule {
  id: string;
  name: string | null;
  cadence: string | null;
  next_run_at: string;
  warehouse_id: string | null;
}

export interface OperatorProductivityRow {
  user_id: string;
  lines_counted: number;
  variance_lines: number;
  flagged_lines: number;
}

export interface BinHeatmapRow {
  location_id: string | null;
  location_code: string | null;
  location_name: string | null;
  counted_lines: number;
  variance_lines: number;
  abs_variance_qty: number;
}

export interface CountActivityRow {
  id: string;
  session_id: string;
  session_code: string | null;
  counted_at: string;
  counted_by: string | null;
  tolerance_outcome: string | null;
  recount_round: number | null;
  product_id: string | null;
  product_name: string | null;
  location_code: string | null;
  variance_qty: number | null;
}

export interface AccuracyTrendPoint {
  day: string;
  counted_lines: number;
  accurate_lines: number;
}

export interface CountCommandCenter {
  in_progress: number;
  in_review: number;
  awaiting_approval: number;
  posted_30d: number;
  open_recounts: number;
  overdue_schedules: OverdueSchedule[];
  accuracy_counted_lines: number;
  accuracy_accurate_lines: number;
  accuracy_trend: AccuracyTrendPoint[];
  operator_productivity: OperatorProductivityRow[];
  bin_heatmap: BinHeatmapRow[];
  activity: CountActivityRow[];
  generated_at: string;
}

export function useCountSessionBoard(
  businessId: string | undefined,
  warehouseId?: string | null,
) {
  return useQuery({
    queryKey: ["wms-count-sessions", "board", businessId, warehouseId ?? null],
    enabled: !!businessId,
    queryFn: async (): Promise<CountSessionBoardRow[]> => {
      const { data, error } = await supabase.rpc("get_count_session_board", {
        p_business_id: businessId!,
        p_warehouse_id: warehouseId ?? null,
      });
      if (error) throw error;
      return (data ?? []) as unknown as CountSessionBoardRow[];
    },
  });
}

export function useCountCommandCenter(
  businessId: string | undefined,
  warehouseId?: string | null,
) {
  return useQuery({
    queryKey: ["wms-count-sessions", "command-center", businessId, warehouseId ?? null],
    enabled: !!businessId,
    queryFn: async (): Promise<CountCommandCenter> => {
      const { data, error } = await supabase.rpc("get_count_command_center", {
        p_business_id: businessId!,
        p_warehouse_id: warehouseId ?? null,
      });
      if (error) throw error;
      return data as unknown as CountCommandCenter;
    },
  });
}

/** Counting accuracy as a percentage, or null when nothing was counted. */
export function accuracyPct(counted: number, accurate: number): number | null {
  if (!counted) return null;
  return Math.round((accurate / counted) * 1000) / 10;
}
