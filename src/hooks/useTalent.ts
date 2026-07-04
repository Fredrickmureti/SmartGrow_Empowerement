/**
 * useTalent — Talent Management hooks (Phase 1: Goals lifecycle).
 *
 * Wraps the new tables (goal_milestones, goal_updates, competency_assessments,
 * development_plans, development_plan_items, review_*) and the extended
 * performance_cycles / performance_goals columns. Uses light `any` casts in
 * a few places because the generated Supabase types haven't picked up the
 * new tables yet for this turn.
 *
 * All writes that should reach employees/managers also push a notification
 * via `notifyTalent` — that is the whole point of Phase 1: each action moves
 * the next stage forward.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { notifyTalent } from "@/lib/talent/notifications";

export type CyclePhase =
  | "planning"
  | "goal_setting"
  | "in_progress"
  | "self_review"
  | "manager_review"
  | "peer_review"
  | "calibration"
  | "sign_off"
  | "closed";

export type GoalAlignment = "organization" | "department" | "team" | "individual";
export type GoalStatus = "not_started" | "in_progress" | "at_risk" | "completed" | "cancelled";
export type GoalMeasurement = "percent" | "number" | "currency" | "boolean" | "milestone";
export type MilestoneStatus = "pending" | "in_progress" | "done" | "skipped";

export interface TalentCycle {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  period_start: string;
  period_end: string;
  status: string;
  phase: CyclePhase;
  goal_setting_open_at: string | null;
  goal_setting_due_at: string | null;
  self_review_open_at: string | null;
  self_review_due_at: string | null;
  manager_review_open_at: string | null;
  manager_review_due_at: string | null;
  scope: "organization" | "department" | "custom";
  scope_department_ids: string[] | null;
  default_template_id: string | null;
}

export interface TalentGoal {
  id: string;
  organization_id: string;
  employee_id: string;
  cycle_id: string | null;
  parent_goal_id: string | null;
  title: string;
  description: string | null;
  weight: number;
  alignment: GoalAlignment;
  measurement_type: GoalMeasurement;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  category: string | null;
  target_date: string | null;
  status: GoalStatus;
  progress_pct: number;
  assigned_by: string | null;
  assigned_at: string | null;
  last_check_in_at: string | null;
  next_check_in_due_at: string | null;
  manager_comment: string | null;
  final_rating: number | null;
  created_at: string;
}

export interface GoalMilestone {
  id: string;
  organization_id: string;
  goal_id: string;
  title: string;
  due_date: string | null;
  weight: number;
  status: MilestoneStatus;
  sort_order: number;
  completed_at: string | null;
  notes: string | null;
}

export interface GoalUpdate {
  id: string;
  organization_id: string;
  goal_id: string;
  milestone_id: string | null;
  update_type:
    | "check_in"
    | "manager_feedback"
    | "blocker"
    | "milestone_completed"
    | "status_change"
    | "rating";
  author_user_id: string | null;
  author_role: "employee" | "manager" | "hr" | "system" | null;
  progress_pct: number | null;
  status_to: string | null;
  comment: string | null;
  created_at: string;
}

// =====================================================================
// Cycles
// =====================================================================
export function useTalentCycles() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: cycles = [], isLoading } = useQuery({
    queryKey: ["talent-cycles", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("performance_cycles") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("period_start", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TalentCycle[];
    },
    enabled: !!currentOrg?.id,
  });

  const createCycle = useMutation({
    mutationFn: async (input: {
      name: string;
      period_start: string;
      period_end: string;
      description?: string;
      goal_setting_due_at?: string | null;
      self_review_due_at?: string | null;
      manager_review_due_at?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await (supabase.from("performance_cycles") as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        status: "draft",
        phase: "planning",
        created_by: user?.id ?? null,
        ...input,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-cycles"] });
      toast.success("Cycle created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const advancePhase = useMutation({
    mutationFn: async ({ id, phase }: { id: string; phase: CyclePhase }) => {
      // Server-enforced via security-definer RPC. Direct UPDATEs to `phase`
      // are blocked by the talent_guard_performance_cycles trigger.
      const { error } = await (supabase as any).rpc("talent_advance_cycle_phase", {
        _cycle_id: id,
        _next_phase: phase,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-cycles"] });
      toast.success("Cycle phase updated");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });


  return { cycles, isLoading, createCycle, advancePhase };
}

// =====================================================================
// Goals (with notifications)
// =====================================================================
export function useTalentGoals(opts: { employeeId?: string; cycleId?: string; managerId?: string } = {}) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { employeeId, cycleId, managerId } = opts;

  const { data: goals = [], isLoading } = useQuery({
    queryKey: ["talent-goals", currentOrg?.id, employeeId ?? null, cycleId ?? null, managerId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("performance_goals") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (cycleId) q = q.eq("cycle_id", cycleId);
      if (managerId) {
        // Filter to direct reports of this manager (employees.manager_id matching).
        const { data: reports } = await supabase
          .from("v_employees_canonical")
          .select("id")
          .eq("manager_id", managerId);
        const ids = (reports ?? []).map((r: any) => r.id);
        if (ids.length === 0) return [];
        q = q.in("employee_id", ids);
      }
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TalentGoal[];
    },
    enabled: !!currentOrg?.id,
  });

  const assignGoal = useMutation({
    mutationFn: async (input: {
      employee_id: string;
      title: string;
      description?: string;
      cycle_id?: string | null;
      parent_goal_id?: string | null;
      weight?: number;
      alignment?: GoalAlignment;
      measurement_type?: GoalMeasurement;
      target_value?: number | null;
      current_value?: number | null;
      unit?: string | null;
      category?: string | null;
      target_date?: string | null;
      next_check_in_due_at?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const payload: any = {
        organization_id: currentOrg.id,
        status: "not_started",
        progress_pct: 0,
        weight: input.weight ?? 100,
        alignment: input.alignment ?? "individual",
        measurement_type: input.measurement_type ?? "percent",
        assigned_by: user?.id ?? null,
        assigned_at: new Date().toISOString(),
        created_by: user?.id ?? null,
        ...input,
      };
      const { data, error } = await (supabase.from("performance_goals") as any)
        .insert(payload)
        .select("id, title, employee_id")
        .single();
      if (error) throw error;

      // Notify the assignee.
      await notifyTalent({
        organizationId: currentOrg.id,
        employeeId: data.employee_id,
        kind: "goal.assigned",
        title: "New goal assigned",
        message: `You have a new goal: ${data.title}`,
        link: `/me/talent/goals/${data.id}`,
        entityType: "performance_goal",
        entityId: data.id,
        priority: 2,
      });

      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-goals"] });
      toast.success("Goal assigned");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateGoal = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<TalentGoal> }) => {
      const { error } = await (supabase.from("performance_goals") as any)
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-goals"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { goals, isLoading, assignGoal, updateGoal };
}

export function useTalentGoal(goalId?: string) {
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data: goal, isLoading } = useQuery({
    queryKey: ["talent-goal", goalId],
    queryFn: async () => {
      if (!goalId) return null;
      const { data, error } = await (supabase.from("performance_goals") as any)
        .select("*")
        .eq("id", goalId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as TalentGoal | null;
    },
    enabled: !!goalId,
  });

  const { data: milestones = [] } = useQuery({
    queryKey: ["talent-goal-milestones", goalId],
    queryFn: async () => {
      if (!goalId) return [];
      const { data, error } = await (supabase.from("goal_milestones") as any)
        .select("*")
        .eq("goal_id", goalId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as GoalMilestone[];
    },
    enabled: !!goalId,
  });

  const { data: updates = [] } = useQuery({
    queryKey: ["talent-goal-updates", goalId],
    queryFn: async () => {
      if (!goalId) return [];
      const { data, error } = await (supabase.from("goal_updates") as any)
        .select("*")
        .eq("goal_id", goalId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as GoalUpdate[];
    },
    enabled: !!goalId,
  });

  const addMilestone = useMutation({
    mutationFn: async (input: { title: string; due_date?: string | null; weight?: number; sort_order?: number }) => {
      if (!goal) throw new Error("Goal not loaded");
      const { error } = await (supabase.from("goal_milestones") as any).insert({
        organization_id: goal.organization_id,
        goal_id: goal.id,
        weight: input.weight ?? 0,
        sort_order: input.sort_order ?? 0,
        ...input,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["talent-goal-milestones", goalId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateMilestone = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<GoalMilestone> }) => {
      const next: any = { ...patch };
      if (patch.status === "done" && !patch.completed_at) {
        next.completed_at = new Date().toISOString();
      }
      const { error } = await (supabase.from("goal_milestones") as any)
        .update(next)
        .eq("id", id);
      if (error) throw error;

      if (patch.status === "done" && goal) {
        await (supabase.from("goal_updates") as any).insert({
          organization_id: goal.organization_id,
          goal_id: goal.id,
          milestone_id: id,
          update_type: "milestone_completed",
          author_user_id: user?.id ?? null,
          author_role: "employee",
          comment: "Milestone marked complete",
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-goal-milestones", goalId] });
      qc.invalidateQueries({ queryKey: ["talent-goal-updates", goalId] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  /**
   * Employee check-in: writes a goal_updates row, updates progress_pct +
   * last_check_in_at on the goal, and notifies the manager.
   */
  const checkIn = useMutation({
    mutationFn: async (input: { progress_pct: number; comment?: string; status?: GoalStatus }) => {
      if (!goal) throw new Error("Goal not loaded");
      const patch: any = {
        progress_pct: Math.max(0, Math.min(100, input.progress_pct)),
        last_check_in_at: new Date().toISOString(),
      };
      if (input.status) patch.status = input.status;
      const { error: upErr } = await (supabase.from("performance_goals") as any)
        .update(patch)
        .eq("id", goal.id);
      if (upErr) throw upErr;

      const { error: insErr } = await (supabase.from("goal_updates") as any).insert({
        organization_id: goal.organization_id,
        goal_id: goal.id,
        update_type: "check_in",
        author_user_id: user?.id ?? null,
        author_role: "employee",
        progress_pct: patch.progress_pct,
        status_to: input.status ?? null,
        comment: input.comment ?? null,
      });
      if (insErr) throw insErr;

      // Notify manager (resolve via employees.manager_id → manager employee → user_id).
      const emp = await getManagerFor(goal.employee_id);
      if (emp?.manager_id) {
        await notifyTalent({
          organizationId: goal.organization_id,
          employeeId: emp.manager_id,
          kind: "goal.updated",
          title: "Goal check-in submitted",
          message: `${displayName(emp)} updated "${goal.title}" to ${patch.progress_pct}%`,
          link: `/hr/talent/goals/${goal.id}`,
          entityType: "performance_goal",
          entityId: goal.id,
          priority: 3,
        });
      }

      // Phase 2: fire goal.completed when the check-in transitions the goal to done/100%
      const isCompleted =
        input.status === "completed" || (patch.progress_pct >= 100 && (input.status ?? goal.status) !== "cancelled");
      if (isCompleted) {
        // Notify employee (self-service confirmation) and manager
        await notifyTalent({
          organizationId: goal.organization_id,
          employeeId: goal.employee_id,
          kind: "goal.completed",
          title: "Goal completed",
          message: `You completed "${goal.title}".`,
          link: `/me/talent/goals/${goal.id}`,
          entityType: "performance_goal",
          entityId: goal.id,
          priority: 2,
        });
        if (emp?.manager_id) {
          await notifyTalent({
            organizationId: goal.organization_id,
            employeeId: emp.manager_id,
            kind: "goal.completed",
            title: "Goal completed",
            message: `${displayName(emp)} completed "${goal.title}".`,
            link: `/hr/talent/goals/${goal.id}`,
            entityType: "performance_goal",
            entityId: goal.id,
            priority: 2,
          });
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-goal", goalId] });
      qc.invalidateQueries({ queryKey: ["talent-goal-updates", goalId] });
      qc.invalidateQueries({ queryKey: ["talent-goals"] });
      toast.success("Check-in submitted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  /**
   * Manager feedback on a goal — writes an update + notifies the employee.
   */
  const addManagerFeedback = useMutation({
    mutationFn: async (input: { comment: string; rating?: number | null; status?: GoalStatus }) => {
      if (!goal) throw new Error("Goal not loaded");
      const patch: any = { manager_comment: input.comment };
      if (input.rating != null) patch.final_rating = input.rating;
      if (input.status) patch.status = input.status;
      const { error: upErr } = await (supabase.from("performance_goals") as any)
        .update(patch)
        .eq("id", goal.id);
      if (upErr) throw upErr;

      await (supabase.from("goal_updates") as any).insert({
        organization_id: goal.organization_id,
        goal_id: goal.id,
        update_type: "manager_feedback",
        author_user_id: user?.id ?? null,
        author_role: "manager",
        comment: input.comment,
        status_to: input.status ?? null,
      });

      await notifyTalent({
        organizationId: goal.organization_id,
        employeeId: goal.employee_id,
        kind: "goal.feedback",
        title: "Manager feedback on your goal",
        message: `Your manager left feedback on "${goal.title}"`,
        link: `/me/talent/goals/${goal.id}`,
        entityType: "performance_goal",
        entityId: goal.id,
        priority: 2,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-goal", goalId] });
      qc.invalidateQueries({ queryKey: ["talent-goal-updates", goalId] });
      qc.invalidateQueries({ queryKey: ["talent-goals"] });
      toast.success("Feedback recorded");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { goal, milestones, updates, isLoading, addMilestone, updateMilestone, checkIn, addManagerFeedback };
}
