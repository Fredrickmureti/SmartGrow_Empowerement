/**
 * useDevelopmentPlans — Phase 2 (Track A item 1): Development Plans
 * end-to-end.
 *
 * Surfaces:
 *   • HR — manage every plan in the org
 *   • Manager — manage plans for direct reports (via employee_id filter)
 *   • Employee — read their own plan and tick off items
 *
 * Notifies the counterparty on every meaningful state change.
 *
 * Auto-suggestion sources:
 *   • Competency gaps  (employee_competencies / competency_assessments vs
 *     competency_role_requirements for their job_position / department).
 *   • Latest review's development_areas string (one item per non-empty line).
 *
 * Types are intentionally lightweight `any` casts at the Supabase boundary
 * because the generated types haven't picked these tables up yet.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { notifyTalent } from "@/lib/talent/notifications";

export type DevPlanStatus = "draft" | "active" | "on_hold" | "completed" | "cancelled";
export type DevPlanItemStatus = "not_started" | "in_progress" | "blocked" | "completed" | "cancelled";
export type DevPlanItemType =
  | "competency"
  | "training"
  | "goal"
  | "stretch_assignment"
  | "mentoring"
  | "reading"
  | "other";

export interface DevelopmentPlan {
  id: string;
  organization_id: string;
  employee_id: string;
  cycle_id: string | null;
  title: string;
  summary: string | null;
  status: DevPlanStatus;
  start_date: string | null;
  target_completion_date: string | null;
  manager_user_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DevelopmentPlanItem {
  id: string;
  organization_id: string;
  plan_id: string;
  item_type: DevPlanItemType;
  title: string;
  description: string | null;
  competency_id: string | null;
  training_course_id: string | null;
  goal_id: string | null;
  enrollment_id: string | null;
  due_date: string | null;
  status: DevPlanItemStatus;
  progress_pct: number;
  completed_at: string | null;
  sort_order: number;
}

// =====================================================================
// Plans
// =====================================================================
export function useDevelopmentPlans(opts: { employeeId?: string; managerId?: string } = {}) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { employeeId, managerId } = opts;

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["dev-plans", currentOrg?.id, employeeId ?? null, managerId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("development_plans") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (managerId) {
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
      return (data ?? []) as DevelopmentPlan[];
    },
    enabled: !!currentOrg?.id,
  });

  const createPlan = useMutation({
    mutationFn: async (input: {
      employee_id: string;
      title: string;
      summary?: string | null;
      cycle_id?: string | null;
      start_date?: string | null;
      target_completion_date?: string | null;
      manager_user_id?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const payload: any = {
        organization_id: currentOrg.id,
        status: "draft",
        manager_user_id: input.manager_user_id ?? user?.id ?? null,
        ...input,
      };
      const { data, error } = await (supabase.from("development_plans") as any)
        .insert(payload)
        .select("id, title, employee_id")
        .single();
      if (error) throw error;
      return data as { id: string; title: string; employee_id: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-plans"] });
      toast.success("Development plan created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updatePlan = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<DevelopmentPlan> }) => {
      const { error } = await (supabase.from("development_plans") as any)
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dev-plans"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deletePlan = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("development_plans") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-plans"] });
      toast.success("Plan deleted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  /**
   * Activate (draft → active). Notifies the employee that they have a plan.
   */
  const activatePlan = useMutation({
    mutationFn: async (plan: DevelopmentPlan) => {
      const { error } = await (supabase.from("development_plans") as any)
        .update({ status: "active", approved_by: user?.id ?? null, approved_at: new Date().toISOString() })
        .eq("id", plan.id);
      if (error) throw error;
      await notifyTalent({
        organizationId: plan.organization_id,
        employeeId: plan.employee_id,
        kind: "development.plan_updated",
        title: "Your development plan is active",
        message: `"${plan.title}" is now active. Check the actions and start ticking them off.`,
        link: `/me/talent/development`,
        entityType: "development_plan",
        entityId: plan.id,
        priority: 2,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-plans"] });
      toast.success("Plan activated");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { plans, isLoading, createPlan, updatePlan, deletePlan, activatePlan };
}

// =====================================================================
// Single plan + items
// =====================================================================
export function useDevelopmentPlan(planId?: string) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: plan } = useQuery({
    queryKey: ["dev-plan", planId],
    queryFn: async () => {
      if (!planId) return null;
      const { data, error } = await (supabase.from("development_plans") as any)
        .select("*")
        .eq("id", planId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as DevelopmentPlan | null;
    },
    enabled: !!planId,
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["dev-plan-items", planId],
    queryFn: async () => {
      if (!planId) return [];
      const { data, error } = await (supabase.from("development_plan_items") as any)
        .select("*")
        .eq("plan_id", planId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as DevelopmentPlanItem[];
    },
    enabled: !!planId,
  });

  const addItem = useMutation({
    mutationFn: async (input: {
      item_type: DevPlanItemType;
      title: string;
      description?: string | null;
      competency_id?: string | null;
      training_course_id?: string | null;
      goal_id?: string | null;
      due_date?: string | null;
    }) => {
      if (!plan) throw new Error("Plan not loaded");
      const sort_order = items.length ? Math.max(...items.map((i) => i.sort_order)) + 1 : 0;
      const { error } = await (supabase.from("development_plan_items") as any).insert({
        organization_id: plan.organization_id,
        plan_id: plan.id,
        status: "not_started",
        progress_pct: 0,
        sort_order,
        ...input,
      });
      if (error) throw error;
      // Notify the employee if plan is active
      if (plan.status === "active") {
        await notifyTalent({
          organizationId: plan.organization_id,
          employeeId: plan.employee_id,
          kind: "development.plan_updated",
          title: "New action on your development plan",
          message: `"${input.title}" was added to "${plan.title}".`,
          link: `/me/talent/development`,
          entityType: "development_plan",
          entityId: plan.id,
        });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dev-plan-items", planId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateItem = useMutation({
    mutationFn: async ({ id, patch, notify }: { id: string; patch: Partial<DevelopmentPlanItem>; notify?: boolean }) => {
      // Phase 5: completions go through the RPC so competency assessments
      // get uplifted and the transition is audit-logged. Non-completion
      // patches keep the direct UPDATE path (title, description, dates).
      if (patch.status === "completed") {
        const { error: rpcErr } = await (supabase.rpc as any)("talent_devplan_item_complete", { _item_id: id });
        if (rpcErr) throw rpcErr;
      } else {
        const next: any = { ...patch };
        const { error } = await (supabase.from("development_plan_items") as any)
          .update(next)
          .eq("id", id);
        if (error) throw error;
      }

      // Notify manager when employee marks an item complete
      if (notify && plan && patch.status === "completed") {
        const { data: emp } = await supabase
          .from("v_employees_canonical")
          .select("manager_id, first_name, last_name")
          .eq("id", plan.employee_id)
          .maybeSingle();
        const item = items.find((i) => i.id === id);
        if (emp?.manager_id && item) {
          await notifyTalent({
            organizationId: plan.organization_id,
            employeeId: emp.manager_id,
            kind: "development.plan_updated",
            title: "Development action completed",
            message: `${emp.first_name ?? ""} ${emp.last_name ?? ""} completed "${item.title}".`,
            link: `/hr/talent/development?employee=${plan.employee_id}`,
            entityType: "development_plan",
            entityId: plan.id,
            priority: 3,
          });
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dev-plan-items", planId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteItem = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("development_plan_items") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dev-plan-items", planId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  /**
   * Suggest plan items from competency gaps. Returns the suggestions
   * (does NOT insert) so the caller can review before committing.
   */
  const suggestFromGaps = async (): Promise<Array<{
    item_type: DevPlanItemType;
    title: string;
    description: string;
    competency_id: string;
  }>> => {
    if (!plan || !currentOrg?.id) return [];
    // 1. Resolve employee → job_position_id + department_id
    const { data: emp } = await supabase
      .from("v_employees_canonical")
      .select("id, department_id, position")
      .eq("id", plan.employee_id)
      .maybeSingle();
    if (!emp) return [];

    // 2. Pull role requirements + assessments + competencies
    const [reqsRes, assessRes, compRes] = await Promise.all([
      (supabase.from("competency_role_requirements") as any)
        .select("*")
        .eq("organization_id", currentOrg.id),
      (supabase.from("competency_assessments") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", plan.employee_id),
      (supabase.from("competencies") as any)
        .select("id, name, description")
        .eq("organization_id", currentOrg.id),
    ]);
    const reqs: any[] = reqsRes.data ?? [];
    const assess: any[] = assessRes.data ?? [];
    const comps: any[] = compRes.data ?? [];
    const compById = new Map(comps.map((c) => [c.id, c]));
    const existingCompIds = new Set(items.filter((i) => i.competency_id).map((i) => i.competency_id));

    const out: Array<{ item_type: DevPlanItemType; title: string; description: string; competency_id: string }> = [];
    for (const r of reqs) {
      // require department OR (no position resolution available) — for v1 we
      // just take department_id matches and any global requirement.
      const matches = (r.department_id && r.department_id === emp.department_id) ||
        (!r.department_id && !r.job_position_id);
      if (!matches) continue;
      if (existingCompIds.has(r.competency_id)) continue;
      const a = assess.find((x) => x.competency_id === r.competency_id);
      const current = a?.final_level ?? a?.manager_level ?? a?.self_level ?? 0;
      const required = Number(r.required_level ?? 0);
      if (current < required) {
        const c = compById.get(r.competency_id);
        if (!c) continue;
        out.push({
          item_type: "competency",
          competency_id: r.competency_id,
          title: `Build ${c.name} to level ${required}`,
          description: `Current: ${current || "not assessed"} · Required: ${required}${
            r.is_critical ? " · CRITICAL" : ""
          }${c.description ? `\n\n${c.description}` : ""}`,
        });
      }
    }
    return out;
  };

  /**
   * Suggest plan items from the latest signed-off review's
   * `development_areas` text. One item per non-empty line / bullet.
   */
  const suggestFromLatestReview = async (): Promise<Array<{
    item_type: DevPlanItemType;
    title: string;
    description: string;
  }>> => {
    if (!plan) return [];
    const { data: review } = await (supabase.from("performance_reviews") as any)
      .select("development_areas, signed_off_at")
      .eq("employee_id", plan.employee_id)
      .in("status", ["signed_off", "acknowledged"])
      .order("signed_off_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const text = (review?.development_areas as string | null) ?? "";
    if (!text.trim()) return [];
    const lines = text
      .split(/\r?\n|•|—|–|\u2022/)
      .map((l) => l.replace(/^[\s\-\*\d\.\)]+/, "").trim())
      .filter((l) => l.length > 3);
    return lines.map((l) => ({
      item_type: "other" as DevPlanItemType,
      title: l.slice(0, 120),
      description: l.length > 120 ? l : "From latest performance review.",
    }));
  };

  /** Bulk-insert pre-reviewed suggestions. */
  const addItemsBulk = useMutation({
    mutationFn: async (rows: Array<Partial<DevelopmentPlanItem> & { item_type: DevPlanItemType; title: string }>) => {
      if (!plan) throw new Error("Plan not loaded");
      const base = items.length ? Math.max(...items.map((i) => i.sort_order)) + 1 : 0;
      const payload = rows.map((r, idx) => ({
        organization_id: plan.organization_id,
        plan_id: plan.id,
        status: "not_started" as DevPlanItemStatus,
        progress_pct: 0,
        sort_order: base + idx,
        ...r,
      }));
      const { error } = await (supabase.from("development_plan_items") as any).insert(payload);
      if (error) throw error;
      if (plan.status === "active") {
        await notifyTalent({
          organizationId: plan.organization_id,
          employeeId: plan.employee_id,
          kind: "development.plan_updated",
          title: `${rows.length} action${rows.length === 1 ? "" : "s"} added to your plan`,
          message: `New items were added to "${plan.title}".`,
          link: `/me/talent/development`,
          entityType: "development_plan",
          entityId: plan.id,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-plan-items", planId] });
      toast.success("Suggestions added");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return {
    plan,
    items,
    isLoading,
    addItem,
    updateItem,
    deleteItem,
    addItemsBulk,
    suggestFromGaps,
    suggestFromLatestReview,
  };
}
