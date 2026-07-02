/**
 * useGoalRollup — Phase E
 *
 * Calls the `f_goal_alignment_rollup()` SQL function (security invoker) and
 * returns weighted rolled-up progress per goal, child-weight sums, and
 * weight-sum / orphan warnings. The function is server-computed so the UI
 * doesn't have to walk the tree itself.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";

export interface GoalRollupRow {
  id: string;
  organization_id: string;
  cycle_id: string | null;
  parent_goal_id: string | null;
  alignment: string;
  title: string;
  weight: number | null;
  own_progress: number;
  rolled_progress: number;
  subtree_depth: number;
  child_weight_sum: number;
  child_count: number;
  weight_sum_warning: boolean | null;
  is_orphan: boolean;
}

export function useGoalRollup(cycleId?: string) {
  const { currentOrg } = useOrganization();
  const q = useQuery({
    queryKey: ["goal-rollup", currentOrg?.id, cycleId],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<GoalRollupRow[]> => {
      const { data, error } = await (supabase as any).rpc("f_goal_alignment_rollup");
      if (error) throw error;
      let rows = (data as GoalRollupRow[]) ?? [];
      rows = rows.filter((r) => r.organization_id === currentOrg!.id);
      if (cycleId) rows = rows.filter((r) => r.cycle_id === cycleId);
      return rows;
    },
  });
  return { rows: q.data ?? [], byId: new Map((q.data ?? []).map((r) => [r.id, r])), isLoading: q.isLoading, error: q.error, refetch: q.refetch };
}
