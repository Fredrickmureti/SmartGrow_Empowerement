/**
 * Labour — performance management (Phase H).
 *
 * Targets are master data resolved most-specific-wins server-side
 * (`wms_resolve_labour_target`), exactly like engineered standards, so a
 * business default, a warehouse rule, a task-type rule and a single
 * operator's rule can coexist without the browser guessing precedence.
 *
 * The scorecard is a server read model (`wms_operator_scorecard`) over the
 * utilisation view — actual vs target performance and utilisation in one
 * row per operator. Coaching is written through `wms_log_coaching_note`,
 * which lands in the existing `continuous_feedback` surface rather than a
 * parallel warehouse-only HR record.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { labourErrorMessage } from "./labourErrors";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import type { WmsTaskType } from "./useLabourOperators";

export interface LabourTarget {
  id: string;
  business_id: string;
  warehouse_id: string | null;
  operator_id: string | null;
  task_type: WmsTaskType | null;
  target_performance_pct: number;
  target_utilisation_pct: number;
  incentive_threshold_pct: number | null;
  incentive_rate_per_earned_hour: number;
  notes: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface LabourTargetUpsert {
  id?: string;
  warehouse_id: string | null;
  operator_id: string | null;
  task_type: WmsTaskType | null;
  target_performance_pct: number;
  target_utilisation_pct: number;
  incentive_threshold_pct: number | null;
  incentive_rate_per_earned_hour: number;
  notes: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface ScorecardRow {
  operator_id: string;
  user_id: string | null;
  warehouse_id: string | null;
  operator_code: string | null;
  operator_name: string;
  tasks_completed: number;
  earned_seconds: number;
  direct_seconds: number;
  indirect_seconds: number;
  idle_seconds: number;
  performance_pct: number | null;
  utilisation_pct: number | null;
  target_performance_pct: number | null;
  target_utilisation_pct: number | null;
  performance_variance: number | null;
  utilisation_variance: number | null;
  incentive_eligible: boolean;
}

export const PERFORMANCE_KEYS = {
  targets: ["wms", "labour", "targets"] as const,
  scorecard: ["wms", "labour", "scorecard"] as const,
};

function whFilter(warehouseId?: string): string | undefined {
  return warehouseId && warehouseId !== "all" ? warehouseId : undefined;
}

export function useLabourTargets(warehouseId?: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...PERFORMANCE_KEYS.targets, currentBusiness?.id, warehouseId ?? "all"],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_labour_targets")
        .select(
          "id,business_id,warehouse_id,operator_id,task_type,target_performance_pct,target_utilisation_pct,incentive_threshold_pct,incentive_rate_per_earned_hour,notes,effective_from,effective_to,is_active",
        )
        .eq("business_id", currentBusiness!.id)
        .order("effective_from", { ascending: false });
      const wh = whFilter(warehouseId);
      // A business-wide target (warehouse_id NULL) applies to every warehouse,
      // so it must stay visible when the board is scoped to one site.
      if (wh) q = q.or(`warehouse_id.eq.${wh},warehouse_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LabourTarget[];
    },
  });
}

export function useOperatorScorecard(warehouseId: string | undefined, from: string, to: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...PERFORMANCE_KEYS.scorecard, currentBusiness?.id, warehouseId ?? "all", from, to],
    enabled: !!currentBusiness?.id,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wms_operator_scorecard", {
        _warehouse_id: whFilter(warehouseId),
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return (data ?? []) as unknown as ScorecardRow[];
    },
  });
}

export function useSaveLabourTarget() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();

  return useMutation({
    mutationFn: async (input: LabourTargetUpsert) => {
      if (!currentBusiness?.id) throw new Error("No business selected");
      const row = {
        ...input,
        business_id: currentBusiness.id,
        organization_id: currentOrg?.id ?? null,
      };
      const { data, error } = await supabase
        .from("wms_labour_targets")
        .upsert(row as never)
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PERFORMANCE_KEYS.targets });
      qc.invalidateQueries({ queryKey: PERFORMANCE_KEYS.scorecard });
      toast.success("Target saved");
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e) || "Target could not be saved"),
  });
}

export function useDeleteLabourTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("wms_labour_targets").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PERFORMANCE_KEYS.targets });
      qc.invalidateQueries({ queryKey: PERFORMANCE_KEYS.scorecard });
      toast.success("Target removed");
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e) || "Target could not be removed"),
  });
}

export function useLogCoachingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { operatorId: string; body: string; feedbackType?: string }) => {
      const { data, error } = await supabase.rpc("wms_log_coaching_note", {
        _operator_id: input.operatorId,
        _body: input.body,
        _feedback_type: input.feedbackType ?? "coaching",
      });
      if (error) throw error;
      return data as unknown as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PERFORMANCE_KEYS.scorecard });
      toast.success("Coaching note recorded");
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e) || "Coaching note could not be recorded"),
  });
}
