/**
 * useTalentAnalytics — Phase D
 *
 * Read-only hooks over the analytics views created in the Phase D migration:
 *  - useManagerTeamRollup() → v_manager_team_rollup, scoped to the calling
 *    employee acting as manager.
 *  - useExecutiveTalent()   → v_exec_talent_rollup (org-wide; RLS on the
 *    underlying tables already restricts visibility).
 *  - useCompetencyGapHeatmap() → v_competency_gap_heatmap.
 *
 * Views are SECURITY INVOKER + GRANT SELECT to authenticated, so they
 * naturally inherit org / branch / RLS scoping from the underlying tables.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";

export interface ManagerTeamRollup {
  manager_employee_id: string;
  organization_id: string;
  team_size: number;
  active_goals: number;
  at_risk_goals: number;
  overdue_check_ins: number;
  reviews_done: number;
  reviews_total: number;
  review_completion_pct: number | null;
  employees_with_devplan: number;
  devplan_coverage_pct: number;
  kudos_last_30d: number;
}

export interface ExecTalentRollup {
  organization_id: string;
  department_id: string | null;
  headcount: number;
  reviews_done: number;
  reviews_total: number;
  review_completion_pct: number | null;
  avg_rating: number | null;
  rating_distribution: Record<string, number> | null;
  succession_key_roles: number;
  successors_ready_now: number;
  successors_ready_1_2y: number;
  successors_ready_3_5y: number;
  learning_assigned: number;
  learning_completed: number;
  learning_compliance_pct: number | null;
}

export interface CompetencyGapRow {
  organization_id: string;
  department_id: string | null;
  competency_id: string;
  avg_required_level: number;
  avg_current_level: number;
  gap: number;
  employees_evaluated: number;
  employees_below: number;
}

/** Resolve the current user's employee_id within the active organization. */
function useCurrentEmployeeId() {
  const { user } = useAuth();
  const { currentOrg } = useOrganization();
  return useQuery({
    queryKey: ["talent-analytics", "me-employee", user?.id, currentOrg?.id],
    enabled: !!user?.id && !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_employees_canonical")
        .select("id")
        .eq("user_id", user!.id)
        .eq("organization_id", currentOrg!.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.id as string | undefined) ?? null;
    },
  });
}

export function useManagerTeamRollup() {
  const { currentOrg } = useOrganization();
  const { data: meEmployeeId } = useCurrentEmployeeId();

  const q = useQuery({
    queryKey: ["v_manager_team_rollup", currentOrg?.id, meEmployeeId],
    enabled: !!currentOrg?.id && !!meEmployeeId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_manager_team_rollup")
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .eq("manager_employee_id", meEmployeeId)
        .maybeSingle();
      if (error) throw error;
      return (data as ManagerTeamRollup | null) ?? null;
    },
  });

  return {
    rollup: q.data ?? null,
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
    meEmployeeId: meEmployeeId ?? null,
  };
}

export function useExecutiveTalent() {
  const { currentOrg } = useOrganization();

  const q = useQuery({
    queryKey: ["v_exec_talent_rollup", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_exec_talent_rollup")
        .select("*")
        .eq("organization_id", currentOrg!.id);
      if (error) throw error;
      return (data as ExecTalentRollup[]) ?? [];
    },
  });

  return {
    rows: q.data ?? [],
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}

export function useCompetencyGapHeatmap() {
  const { currentOrg } = useOrganization();
  const q = useQuery({
    queryKey: ["v_competency_gap_heatmap", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_competency_gap_heatmap")
        .select("*")
        .eq("organization_id", currentOrg!.id);
      if (error) throw error;
      return (data as CompetencyGapRow[]) ?? [];
    },
  });
  return { rows: q.data ?? [], isLoading: q.isLoading, error: q.error };
}
