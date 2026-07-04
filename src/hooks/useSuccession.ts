/**
 * useSuccession — Phase B Talent: succession planning, talent pools, 9-box.
 *
 * Backed by `talent_pools`, `talent_pool_members`, `succession_plans`,
 * `successors`, `talent_potential_ratings` and the `talent_place_on_nine_box`
 * RPC (authoritative write path for the matrix).
 *
 * RLS:
 *  - HR/admin/owner manage everything in their org.
 *  - Managers read records that include their direct reports.
 *  - Employees can read their own pool memberships, their own 9-box cell,
 *    and succession plans where they are the incumbent or a successor.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeError } from "@/services/resilience";

export type PoolType =
  | "general" | "high_potential" | "critical_role"
  | "successor" | "retention_risk" | "leadership";
export type ReadinessTag =
  | "ready_now" | "ready_1_2y" | "ready_3_5y" | "development_needed";
export type SuccessorReadiness =
  | "ready_now" | "ready_1_2y" | "ready_3_5y" | "emergency_cover";
export type Criticality = "low" | "medium" | "high" | "critical";
export type BenchStrength = "strong" | "developing" | "thin" | "at_risk";

export interface TalentPool {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  description: string | null;
  pool_type: PoolType;
  is_active: boolean;
  created_at: string;
}

export interface TalentPoolMember {
  id: string;
  pool_id: string;
  employee_id: string;
  readiness: ReadinessTag | null;
  notes: string | null;
  added_at: string;
}

export interface SuccessionPlan {
  id: string;
  organization_id: string;
  business_id: string | null;
  job_position_id: string | null;
  role_title: string;
  incumbent_employee_id: string | null;
  criticality: Criticality;
  vacancy_risk: "low" | "medium" | "high";
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Successor {
  id: string;
  plan_id: string;
  employee_id: string;
  readiness: SuccessorReadiness;
  rank: number;
  development_notes: string | null;
  added_at: string;
}

export interface NineBoxPlacement {
  id: string;
  organization_id: string;
  cycle_id: string;
  employee_id: string;
  potential: 1 | 2 | 3;
  performance: 1 | 2 | 3;
  placement_reason: string | null;
  placed_by: string | null;
  placed_at: string;
}

export interface BenchStrengthRow {
  plan_id: string;
  role_title: string;
  criticality: Criticality;
  successor_count: number;
  ready_now_count: number;
  ready_1_2y_count: number;
  ready_3_5y_count: number;
  bench_strength: BenchStrength;
}

// =====================================================================
// Talent Pools
// =====================================================================
export function useTalentPools() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: pools = [], isLoading } = useQuery({
    queryKey: ["talent-pools", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("talent_pools") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TalentPool[];
    },
    enabled: !!currentOrg?.id,
  });

  const { data: members = [] } = useQuery({
    queryKey: ["talent-pool-members", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("talent_pool_members") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (error) throw error;
      return (data ?? []) as TalentPoolMember[];
    },
    enabled: !!currentOrg?.id,
  });

  const createPool = useMutation({
    mutationFn: async (input: { name: string; description?: string; pool_type?: PoolType }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await (supabase.from("talent_pools") as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        name: input.name,
        description: input.description ?? null,
        pool_type: input.pool_type ?? "general",
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-pools"] });
      toast.success("Talent pool created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updatePool = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<TalentPool> }) => {
      const { error } = await (supabase.from("talent_pools") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["talent-pools"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deletePool = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("talent_pools") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-pools"] });
      qc.invalidateQueries({ queryKey: ["talent-pool-members"] });
      toast.success("Pool removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const addMember = useMutation({
    mutationFn: async (input: { pool_id: string; employee_id: string; readiness?: ReadinessTag; notes?: string }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await (supabase.from("talent_pool_members") as any).insert({
        organization_id: currentOrg.id,
        pool_id: input.pool_id,
        employee_id: input.employee_id,
        readiness: input.readiness ?? null,
        notes: input.notes ?? null,
        added_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-pool-members"] });
      toast.success("Added to pool");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeMember = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("talent_pool_members") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["talent-pool-members"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { pools, members, isLoading, createPool, updatePool, deletePool, addMember, removeMember };
}

// =====================================================================
// Succession Plans
// =====================================================================
export function useSuccessionPlans() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["succession-plans", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("succession_plans") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("criticality", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SuccessionPlan[];
    },
    enabled: !!currentOrg?.id,
  });

  const { data: successors = [] } = useQuery({
    queryKey: ["successors", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("successors") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("rank", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Successor[];
    },
    enabled: !!currentOrg?.id,
  });

  const { data: benchStrength = [] } = useQuery({
    queryKey: ["bench-strength", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("v_succession_bench_strength") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (error) throw error;
      return (data ?? []) as BenchStrengthRow[];
    },
    enabled: !!currentOrg?.id,
  });

  const createPlan = useMutation({
    mutationFn: async (input: {
      role_title: string;
      job_position_id?: string | null;
      incumbent_employee_id?: string | null;
      criticality?: Criticality;
      vacancy_risk?: "low" | "medium" | "high";
      notes?: string;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await (supabase.from("succession_plans") as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        role_title: input.role_title,
        job_position_id: input.job_position_id ?? null,
        incumbent_employee_id: input.incumbent_employee_id ?? null,
        criticality: input.criticality ?? "high",
        vacancy_risk: input.vacancy_risk ?? "medium",
        notes: input.notes ?? null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["succession-plans"] });
      qc.invalidateQueries({ queryKey: ["bench-strength"] });
      toast.success("Succession plan created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updatePlan = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<SuccessionPlan> }) => {
      const { error } = await (supabase.from("succession_plans") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["succession-plans"] });
      qc.invalidateQueries({ queryKey: ["bench-strength"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deletePlan = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("succession_plans") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["succession-plans"] });
      qc.invalidateQueries({ queryKey: ["successors"] });
      qc.invalidateQueries({ queryKey: ["bench-strength"] });
      toast.success("Plan removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const addSuccessor = useMutation({
    mutationFn: async (input: {
      plan_id: string;
      employee_id: string;
      readiness?: SuccessorReadiness;
      rank?: number;
      development_notes?: string;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await (supabase.from("successors") as any).insert({
        organization_id: currentOrg.id,
        plan_id: input.plan_id,
        employee_id: input.employee_id,
        readiness: input.readiness ?? "ready_1_2y",
        rank: input.rank ?? 1,
        development_notes: input.development_notes ?? null,
        added_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["successors"] });
      qc.invalidateQueries({ queryKey: ["bench-strength"] });
      toast.success("Successor added");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateSuccessor = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Successor> }) => {
      const { error } = await (supabase.from("successors") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["successors"] });
      qc.invalidateQueries({ queryKey: ["bench-strength"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeSuccessor = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("successors") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["successors"] });
      qc.invalidateQueries({ queryKey: ["bench-strength"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return {
    plans, successors, benchStrength, isLoading,
    createPlan, updatePlan, deletePlan,
    addSuccessor, updateSuccessor, removeSuccessor,
  };
}

// =====================================================================
// 9-Box Placements
// =====================================================================
export function useNineBox(cycleId?: string | null) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: placements = [], isLoading } = useQuery({
    queryKey: ["nine-box", currentOrg?.id, cycleId],
    queryFn: async () => {
      if (!currentOrg?.id || !cycleId) return [];
      const { data, error } = await (supabase.from("talent_potential_ratings") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("cycle_id", cycleId);
      if (error) throw error;
      return (data ?? []) as NineBoxPlacement[];
    },
    enabled: !!currentOrg?.id && !!cycleId,
  });

  const place = useMutation({
    mutationFn: async (input: {
      employee_id: string;
      cycle_id: string;
      potential: 1 | 2 | 3;
      placement_reason?: string;
      performance_override?: 1 | 2 | 3;
    }) => {
      const { data, error } = await (supabase as any).rpc("talent_place_on_nine_box", {
        _employee_id: input.employee_id,
        _cycle_id: input.cycle_id,
        _potential: input.potential,
        _placement_reason: input.placement_reason ?? null,
        _performance_override: input.performance_override ?? null,
      });
      if (error) throw error;
      return data as NineBoxPlacement;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nine-box"] });
      toast.success("Placement saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.rpc as any)("talent_remove_from_nine_box", { p_rating_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nine-box"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { placements, isLoading, place, remove };
}
