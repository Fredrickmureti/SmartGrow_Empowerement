/**
 * useMerit — Phase F merit recommendations.
 *
 * Wraps merit_recommendations + the talent_merit_propose/approve/reject/apply
 * RPCs. Apply writes employee_compensation_history (merit_increase) for the
 * approved row in a single transaction inside the security-definer RPC.
 */
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type MeritStatus = "draft" | "proposed" | "approved" | "rejected" | "applied";

export interface MeritRecommendation {
  id: string;
  organization_id: string;
  cycle_id: string;
  employee_id: string;
  review_id: string | null;
  final_rating: number | null;
  current_salary: number;
  recommended_pct: number;
  recommended_amount: number;
  new_salary: number;
  currency_code: string | null;
  effective_date: string;
  status: MeritStatus;
  notes: string | null;
  proposed_by: string | null;
  approved_by: string | null;
  applied_by: string | null;
  applied_at: string | null;
  rejection_reason: string | null;
}

export interface MeritProposeItem {
  employee_id: string;
  review_id?: string | null;
  final_rating?: number | null;
  current_salary: number;
  recommended_pct: number;
  recommended_amount: number;
  new_salary: number;
  currency_code?: string | null;
  effective_date?: string;
  notes?: string | null;
  status?: "draft" | "proposed";
}

const sb = supabase as any;

export function useMeritRecommendations(cycleId: string | undefined) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["merit-recommendations", cycleId],
    enabled: !!cycleId,
    queryFn: async () => {
      const { data, error } = await sb
        .from("merit_recommendations")
        .select("*")
        .eq("cycle_id", cycleId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MeritRecommendation[];
    },
  });
  return { rows: data ?? [], isLoading, refetch };
}

export function useMeritActions() {
  const qc = useQueryClient();
  const invalidate = (cycleId?: string) =>
    qc.invalidateQueries({ queryKey: ["merit-recommendations", cycleId] });

  const propose = useMutation({
    mutationFn: async (input: { cycleId: string; items: MeritProposeItem[] }) => {
      const { data, error } = await sb.rpc("talent_merit_propose", {
        _cycle_id: input.cycleId,
        _items: input.items,
      });
      if (error) throw error;
      return data as MeritRecommendation[];
    },
    onSuccess: (_d, v) => { toast.success("Merit recommendations saved"); invalidate(v.cycleId); },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const approve = useMutation({
    mutationFn: async (input: { cycleId: string; ids: string[] }) => {
      const { data, error } = await sb.rpc("talent_merit_approve", { _ids: input.ids });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, v) => { toast.success("Approved"); invalidate(v.cycleId); },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const reject = useMutation({
    mutationFn: async (input: { cycleId: string; ids: string[]; reason: string }) => {
      const { data, error } = await sb.rpc("talent_merit_reject", {
        _ids: input.ids,
        _reason: input.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, v) => { toast.success("Rejected"); invalidate(v.cycleId); },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const apply = useMutation({
    mutationFn: async (input: { cycleId: string; ids: string[] }) => {
      const { data, error } = await sb.rpc("talent_merit_apply", { _ids: input.ids });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, v) => { toast.success("Applied to compensation history"); invalidate(v.cycleId); },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { propose, approve, reject, apply };
}
