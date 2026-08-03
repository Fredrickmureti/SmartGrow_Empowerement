/**
 * Labour — planning & forecasting (Phase G).
 *
 * Supply is the roster: shift patterns rolled out into dated operator
 * shifts. Demand is projected server-side from the single task engine
 * (`wms_tasks`) through the same engineered standards resolver that
 * produces earned hours, so plan and actuals are denominated in the same
 * currency. Nothing is computed in the browser: `wms_labour_plan` is the
 * one source of truth for required / planned / actual hours.
 *
 * Master data (patterns, shifts) is written through PostgREST under
 * `inventory:write` RLS. Roll-out and publish are RPCs because they are
 * business events — publishing emits `warehouse.labour.plan_published`
 * and `warehouse.labour.gap_detected` onto the warehouse outbox.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import type { WmsTaskType } from "./useLabourOperators";

export type ShiftStatus = "planned" | "published" | "cancelled";

export interface ShiftPattern {
  id: string;
  warehouse_id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  break_minutes: number;
  is_active: boolean;
}

export interface OperatorShift {
  id: string;
  warehouse_id: string;
  operator_id: string;
  pattern_id: string | null;
  shift_date: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  status: ShiftStatus;
  notes: string | null;
}

export interface LabourPlanRow {
  plan_date: string;
  warehouse_id: string;
  required_seconds: number;
  planned_seconds: number;
  published_seconds: number;
  actual_seconds: number;
  planned_operators: number;
  open_tasks: number;
  overdue_tasks: number;
  gap_seconds: number;
}

export interface LabourDemandRow {
  demand_date: string;
  warehouse_id: string;
  task_type: WmsTaskType;
  open_tasks: number;
  unassigned_tasks: number;
  overdue_tasks: number;
  required_seconds: number;
  unstandardised: number;
}

export interface ShiftPatternUpsert {
  id?: string;
  warehouse_id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  days_of_week: number[];
  break_minutes: number;
  is_active: boolean;
}

export const PLANNING_KEYS = {
  patterns: ["wms-shift-patterns"] as const,
  shifts: ["wms-operator-shifts"] as const,
  plan: ["wms-labour-plan"] as const,
  demand: ["wms-labour-demand"] as const,
};

export const DAY_LABELS: Record<number, string> = {
  1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun",
};

/** ISO date (yyyy-mm-dd) offset from today — planning windows are date-only. */
export function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function whFilter(warehouseId?: string): string | undefined {
  return warehouseId && warehouseId !== "all" ? warehouseId : undefined;
}

export function useShiftPatterns(warehouseId?: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...PLANNING_KEYS.patterns, currentBusiness?.id, warehouseId ?? "all"],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_shift_patterns")
        .select("id,warehouse_id,code,name,start_time,end_time,days_of_week,break_minutes,is_active")
        .eq("business_id", currentBusiness!.id)
        .order("code");
      const wh = whFilter(warehouseId);
      if (wh) q = q.eq("warehouse_id", wh);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ShiftPattern[];
    },
  });
}

export function useOperatorShifts(warehouseId: string | undefined, from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...PLANNING_KEYS.shifts, currentBusiness?.id, warehouseId ?? "all", from, to],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_operator_shifts")
        .select(
          "id,warehouse_id,operator_id,pattern_id,shift_date,start_time,end_time,break_minutes,status,notes",
        )
        .eq("business_id", currentBusiness!.id)
        .gte("shift_date", from)
        .lte("shift_date", to)
        .order("shift_date");
      const wh = whFilter(warehouseId);
      if (wh) q = q.eq("warehouse_id", wh);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as OperatorShift[];
    },
  });
}

export function useLabourPlan(warehouseId: string | undefined, from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...PLANNING_KEYS.plan, currentBusiness?.id, warehouseId ?? "all", from, to],
    enabled: !!currentBusiness?.id,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wms_labour_plan", {
        _warehouse_id: whFilter(warehouseId),
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return (data ?? []) as unknown as LabourPlanRow[];
    },
  });
}

export function useLabourDemand(warehouseId: string | undefined, from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...PLANNING_KEYS.demand, currentBusiness?.id, warehouseId ?? "all", from, to],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wms_labour_demand", {
        _warehouse_id: whFilter(warehouseId),
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return (data ?? []) as unknown as LabourDemandRow[];
    },
  });
}

export function useUpsertShiftPattern() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { organization } = useOrganization();
  return useMutation({
    mutationFn: async (input: ShiftPatternUpsert) => {
      if (!currentBusiness?.id || !organization?.id) throw new Error("No business selected");
      const row = {
        ...input,
        business_id: currentBusiness.id,
        organization_id: organization.id,
      };
      const { error } = await supabase.from("wms_shift_patterns").upsert(row);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.patterns });
      toast.success("Shift pattern saved");
    },
    onError: (e: unknown) =>
      toast.error("Could not save the shift pattern", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });
}

export function useApplyRosterPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      patternId: string;
      operatorIds: string[];
      from: string;
      to: string;
    }) => {
      const { data, error } = await supabase.rpc("wms_apply_roster_pattern", {
        _pattern_id: input.patternId,
        _operator_ids: input.operatorIds,
        _from: input.from,
        _to: input.to,
      });
      if (error) throw error;
      return (data ?? 0) as number;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.shifts });
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.plan });
      toast.success(
        created > 0 ? `${created} shifts rostered` : "No new shifts — roster already covers this window",
      );
    },
    onError: (e: unknown) =>
      toast.error("Could not roll out the roster", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });
}

export interface PublishPlanResult {
  shifts_published: number;
  gaps: Array<{
    date: string;
    required_hours: number;
    planned_hours: number;
    gap_hours: number;
    open_tasks: number;
    overdue_tasks: number;
  }>;
}

export function usePublishLabourPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      warehouseId: string;
      from: string;
      to: string;
      gapThresholdHours?: number;
    }) => {
      const { data, error } = await supabase.rpc("wms_publish_labour_plan", {
        _warehouse_id: input.warehouseId,
        _from: input.from,
        _to: input.to,
        _gap_threshold_hours: input.gapThresholdHours ?? 4,
      });
      if (error) throw error;
      return data as unknown as PublishPlanResult;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.shifts });
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.plan });
      const gaps = result?.gaps?.length ?? 0;
      toast.success(`Roster published — ${result?.shifts_published ?? 0} shifts`, {
        description:
          gaps > 0
            ? `${gaps} day${gaps === 1 ? "" : "s"} short of capacity. Supervisors have been alerted.`
            : "Planned capacity covers projected demand.",
      });
    },
    onError: (e: unknown) =>
      toast.error("Could not publish the labour plan", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });
}

export function useCancelOperatorShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (shiftId: string) => {
      const { error } = await supabase
        .from("wms_operator_shifts")
        .update({ status: "cancelled" })
        .eq("id", shiftId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.shifts });
      qc.invalidateQueries({ queryKey: PLANNING_KEYS.plan });
      toast.success("Shift cancelled");
    },
    onError: (e: unknown) =>
      toast.error("Could not cancel the shift", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });
}
