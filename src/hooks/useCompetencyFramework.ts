/**
 * useCompetencyFramework — Phase 3 Talent: competencies, proficiency scales,
 * role requirements, and dual-source assessments (self + manager → final).
 *
 * The scale is a Json array of { level: number, label: string, description? }.
 * If no scale exists for the org we synthesise a 1–5 default in-memory.
 *
 * Gap analysis: an employee's `final_level` for a competency (fall back to
 * employee_competencies.level for historical data) is compared against the
 * `required_level` from `competency_role_requirements` for their job_position
 * (or department). Negative gap = below requirement → development plan
 * candidate (wired in Phase 4).
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { notifyTalent } from "@/lib/talent/notifications";

export interface ScaleLevel { level: number; label: string; description?: string }

export interface CompetencyScale {
  id: string;
  organization_id: string;
  name: string;
  is_default: boolean;
  levels: ScaleLevel[];
}

export interface Competency {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  category: string | null;
  is_core: boolean;
  is_active: boolean;
  owner_department_id: string | null;
  scale_id: string | null;
}

export interface CompetencyRoleRequirement {
  id: string;
  organization_id: string;
  competency_id: string;
  job_position_id: string | null;
  department_id: string | null;
  required_level: number;
  is_critical: boolean;
}

export interface CompetencyAssessment {
  id: string;
  organization_id: string;
  employee_id: string;
  competency_id: string;
  cycle_id: string | null;
  self_level: number | null;
  self_comment: string | null;
  manager_level: number | null;
  manager_comment: string | null;
  final_level: number | null;
  required_level: number | null;
  status: string;        // 'draft' | 'self_submitted' | 'manager_submitted' | 'finalised'
  assessed_at: string | null;
}

export const DEFAULT_SCALE: ScaleLevel[] = [
  { level: 1, label: "Awareness", description: "Basic understanding; needs supervision." },
  { level: 2, label: "Working", description: "Can perform routine tasks independently." },
  { level: 3, label: "Proficient", description: "Solid practitioner; handles complex situations." },
  { level: 4, label: "Advanced", description: "Recognised expert; coaches others." },
  { level: 5, label: "Expert", description: "Defines best practice; thought leader." },
];

// =====================================================================
// Scales
// =====================================================================
export function useCompetencyScales() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: scales = [], isLoading } = useQuery({
    queryKey: ["competency-scales", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("competency_scales") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("is_default", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((s: any) => ({
        ...s,
        levels: Array.isArray(s.levels) && s.levels.length ? (s.levels as ScaleLevel[]) : DEFAULT_SCALE,
      })) as CompetencyScale[];
    },
    enabled: !!currentOrg?.id,
  });

  const defaultScale = scales.find((s) => s.is_default) ?? scales[0] ?? null;

  const upsertScale = useMutation({
    mutationFn: async (input: { id?: string; name: string; levels: ScaleLevel[]; is_default?: boolean }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      if (input.is_default) {
        await (supabase.from("competency_scales") as any)
          .update({ is_default: false })
          .eq("organization_id", currentOrg.id);
      }
      if (input.id) {
        const { error } = await (supabase.from("competency_scales") as any)
          .update({ name: input.name, levels: input.levels, is_default: input.is_default ?? false })
          .eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase.from("competency_scales") as any).insert({
          organization_id: currentOrg.id,
          name: input.name,
          levels: input.levels,
          is_default: input.is_default ?? false,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["competency-scales"] });
      toast.success("Scale saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { scales, defaultScale, isLoading, upsertScale };
}

// =====================================================================
// Competencies (catalog)
// =====================================================================
export function useCompetencies() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: competencies = [], isLoading } = useQuery({
    queryKey: ["competencies", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("competencies")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Competency[];
    },
    enabled: !!currentOrg?.id,
  });

  const createCompetency = useMutation({
    mutationFn: async (input: { name: string; description?: string; category?: string; is_core?: boolean; scale_id?: string | null }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await supabase.from("competencies").insert({
        organization_id: currentOrg.id,
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? null,
        is_core: input.is_core ?? false,
        is_active: true,
        scale_id: input.scale_id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["competencies"] }); toast.success("Competency added"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { competencies, isLoading, createCompetency };
}

// =====================================================================
// Role requirements
// =====================================================================
export function useRoleRequirements() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: requirements = [], isLoading } = useQuery({
    queryKey: ["competency-role-requirements", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("competency_role_requirements") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (error) throw error;
      return (data ?? []) as CompetencyRoleRequirement[];
    },
    enabled: !!currentOrg?.id,
  });

  const upsertRequirement = useMutation({
    mutationFn: async (input: { competency_id: string; job_position_id?: string | null; department_id?: string | null; required_level: number; is_critical?: boolean }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const existing = requirements.find((r) =>
        r.competency_id === input.competency_id &&
        (r.job_position_id ?? null) === (input.job_position_id ?? null) &&
        (r.department_id ?? null) === (input.department_id ?? null),
      );
      if (existing) {
        const { error } = await (supabase.from("competency_role_requirements") as any)
          .update({ required_level: input.required_level, is_critical: input.is_critical ?? false })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase.from("competency_role_requirements") as any).insert({
          organization_id: currentOrg.id,
          competency_id: input.competency_id,
          job_position_id: input.job_position_id ?? null,
          department_id: input.department_id ?? null,
          required_level: input.required_level,
          is_critical: input.is_critical ?? false,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["competency-role-requirements"] }); toast.success("Requirement saved"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeRequirement = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("competency_role_requirements") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["competency-role-requirements"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { requirements, isLoading, upsertRequirement, removeRequirement };
}

// =====================================================================
// Assessments
// =====================================================================
export function useCompetencyAssessments(opts: { employeeId?: string; cycleId?: string } = {}) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { employeeId, cycleId } = opts;

  const { data: assessments = [], isLoading } = useQuery({
    queryKey: ["competency-assessments", currentOrg?.id, employeeId ?? null, cycleId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("competency_assessments") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (cycleId) q = q.eq("cycle_id", cycleId);
      const { data, error } = await q.order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CompetencyAssessment[];
    },
    enabled: !!currentOrg?.id,
  });

  /**
   * Upsert an assessment row for (employee, competency, cycle). Updates only
   * the side (self/manager) being submitted; the other side is preserved.
   * When both sides are present, computes final_level as average (rounded).
   */
  const submitAssessment = useMutation({
    mutationFn: async (input: {
      employee_id: string;
      competency_id: string;
      cycle_id?: string | null;
      required_level?: number | null;
      side: "self" | "manager";
      level: number;
      comment?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");

      // Find existing row for (employee, competency, cycle)
      let q: any = (supabase.from("competency_assessments") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", input.employee_id)
        .eq("competency_id", input.competency_id);
      if (input.cycle_id) q = q.eq("cycle_id", input.cycle_id);
      else q = q.is("cycle_id", null);
      const { data: existing } = await q.maybeSingle();

      const sideFields = input.side === "self"
        ? { self_level: input.level, self_comment: input.comment ?? null }
        : { manager_level: input.level, manager_comment: input.comment ?? null };

      const merged = { ...(existing ?? {}), ...sideFields };
      const both = merged.self_level != null && merged.manager_level != null;
      const final_level = both ? Math.round((Number(merged.self_level) + Number(merged.manager_level)) / 2) : null;
      const status = both ? "finalised" : (input.side === "self" ? "self_submitted" : "manager_submitted");

      const payload: any = {
        organization_id: currentOrg.id,
        employee_id: input.employee_id,
        competency_id: input.competency_id,
        cycle_id: input.cycle_id ?? null,
        required_level: input.required_level ?? existing?.required_level ?? null,
        ...sideFields,
        final_level,
        status,
        assessed_at: new Date().toISOString(),
      };

      if (existing) {
        const { error } = await (supabase.from("competency_assessments") as any)
          .update(payload)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase.from("competency_assessments") as any).insert(payload);
        if (error) throw error;
      }

      // Notify the other party. If self submitted → notify manager (if known).
      if (input.side === "self") {
        const { data: emp } = await supabase
          .from("v_employees_canonical")
          .select("manager_id")
          .eq("id", input.employee_id)
          .maybeSingle();
        if (emp?.manager_id) {
          await notifyTalent({
            organizationId: currentOrg.id,
            employeeId: emp.manager_id,
            kind: "competency.assess_due",
            title: "Self-assessment submitted",
            message: "A direct report has submitted a competency self-assessment for your review.",
            link: `/hr/talent/competencies`,
            priority: 3,
          });
        }
      } else {
        await notifyTalent({
          organizationId: currentOrg.id,
          employeeId: input.employee_id,
          kind: "competency.assess_due",
          title: "Manager assessment recorded",
          message: "Your manager has recorded a competency assessment.",
          link: `/me/talent/competencies`,
          priority: 3,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["competency-assessments"] });
      toast.success("Assessment saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { assessments, isLoading, submitAssessment };
}

/**
 * Resolve the required level for a (competency, employee). Prefers a job-position
 * requirement, falls back to the department requirement, else null.
 */
export function requiredLevelFor(
  reqs: CompetencyRoleRequirement[],
  competencyId: string,
  jobPositionId: string | null | undefined,
  departmentId: string | null | undefined,
): number | null {
  const j = jobPositionId
    ? reqs.find((r) => r.competency_id === competencyId && r.job_position_id === jobPositionId)
    : null;
  if (j) return j.required_level;
  const d = departmentId
    ? reqs.find((r) => r.competency_id === competencyId && r.department_id === departmentId && !r.job_position_id)
    : null;
  if (d) return d.required_level;
  return null;
}
