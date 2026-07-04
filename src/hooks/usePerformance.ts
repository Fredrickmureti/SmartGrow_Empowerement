/**
 * usePerformance — Turn I hooks for performance & training tables.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { notifyTalent, notifyTalentBulk } from "@/lib/talent/notifications";

export type CycleStatus = "draft" | "open" | "in_progress" | "closed";
export type ReviewStatus = "not_started" | "in_progress" | "submitted" | "acknowledged";
export type GoalStatus = "not_started" | "in_progress" | "at_risk" | "completed" | "cancelled";
export type EnrolStatus = "enrolled" | "in_progress" | "completed" | "dropped" | "failed";

export interface PerformanceCycle { id: string; organization_id: string; name: string; period_start: string; period_end: string; status: CycleStatus; description: string | null; }
export interface PerformanceReview { id: string; cycle_id: string; employee_id: string; reviewer_user_id: string; status: ReviewStatus; overall_rating: number | null; summary: string | null; strengths: string | null; development_areas: string | null; submitted_at: string | null; }
export interface PerformanceGoal { id: string; organization_id: string; employee_id: string; cycle_id: string | null; title: string; description: string | null; target_date: string | null; status: GoalStatus; progress_pct: number; created_at: string; }
export type CourseStatus = "draft" | "published" | "archived";
export interface TrainingCourse { id: string; organization_id: string; name: string; description: string | null; objectives: string | null; provider: string | null; duration_hours: number | null; category: string | null; delivery_mode: string | null; status: CourseStatus; is_active: boolean; requires_certificate: boolean; pass_score: number | null; cover_image_url: string | null; recertify_months: number | null; is_self_enroll: boolean; }
export interface TrainingEnrollment { id: string; organization_id: string; course_id: string; employee_id: string; status: EnrolStatus; enrolled_at: string; started_at: string | null; completed_at: string | null; score: number | null; certificate_url: string | null; due_date: string | null; expires_at: string | null; assigned_by: string | null; source: string; notes: string | null; }
export interface Competency { id: string; organization_id: string; name: string; description: string | null; category: string | null; is_active: boolean; }
export interface EmployeeCompetency { id: string; employee_id: string; competency_id: string; level: number; assessed_at: string; assessor_user_id: string | null; notes: string | null; }

function orgFilter<T>(q: any, orgId?: string) {
  if (!orgId) return q;
  return q.eq("organization_id", orgId) as T;
}

function useOrgInsert() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return { orgId: currentOrg?.id, businessId: currentBusiness?.id ?? null };
}

export function usePerformanceCycles() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: cycles = [], isLoading } = useQuery({
    queryKey: ["perf-cycles", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase.from("performance_cycles").select("*").eq("organization_id", currentOrg.id).order("period_start", { ascending: false });
      if (error) throw error; return (data ?? []) as PerformanceCycle[];
    },
    enabled: !!currentOrg?.id,
  });

  const createCycle = useMutation({
    mutationFn: async (input: Partial<PerformanceCycle> & { name: string; period_start: string; period_end: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("performance_cycles").insert({
        organization_id: currentOrg.id, business_id: currentBusiness?.id ?? null, status: "draft",
        created_by: u?.user?.id ?? "", ...input,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["perf-cycles"] }); toast.success("Cycle created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateCycle = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<PerformanceCycle> }) => {
      const { error } = await supabase.from("performance_cycles").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["perf-cycles"] }); toast.success("Cycle updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { cycles, isLoading, createCycle, updateCycle };
}

export function usePerformanceGoals(employeeId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: goals = [], isLoading } = useQuery({
    queryKey: ["perf-goals", currentOrg?.id, employeeId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase.from("performance_goals").select("*").eq("organization_id", currentOrg.id);
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error; return (data ?? []) as PerformanceGoal[];
    },
    enabled: !!currentOrg?.id,
  });

  const createGoal = useMutation({
    mutationFn: async (input: Partial<PerformanceGoal> & { employee_id: string; title: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("performance_goals").insert({
        organization_id: currentOrg.id, status: "not_started", progress_pct: 0,
        created_by: u?.user?.id ?? "", ...input,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["perf-goals"] }); toast.success("Goal created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateGoal = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<PerformanceGoal> }) => {
      const { error } = await supabase.from("performance_goals").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["perf-goals"] }); toast.success("Goal updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { goals, isLoading, createGoal, updateGoal };
}

export function useTrainingCourses() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: courses = [], isLoading } = useQuery({
    queryKey: ["training-courses", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase.from("training_courses").select("*").eq("organization_id", currentOrg.id).order("name");
      if (error) throw error; return (data ?? []) as TrainingCourse[];
    },
    enabled: !!currentOrg?.id,
  });

  const createCourse = useMutation({
    mutationFn: async (input: Partial<TrainingCourse> & { name: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("training_courses").insert({
        organization_id: currentOrg.id, business_id: currentBusiness?.id ?? null, is_active: true,
        created_by: u?.user?.id ?? "", ...input,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-courses"] }); toast.success("Course created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateCourse = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<TrainingCourse> }) => {
      const { error } = await supabase.from("training_courses").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-courses"] }); toast.success("Course updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const archiveCourse = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("training_courses").update({ status: "archived" as any, is_active: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-courses"] }); toast.success("Course archived"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteCourse = useMutation({
    mutationFn: async (id: string) => {
      // Block delete if any enrollments exist
      const { count, error: cErr } = await supabase
        .from("training_enrollments").select("id", { count: "exact", head: true }).eq("course_id", id);
      if (cErr) throw cErr;
      if ((count ?? 0) > 0) {
        throw new Error("This course has enrollments. Archive it instead.");
      }
      const { error } = await supabase.from("training_courses").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-courses"] }); toast.success("Course deleted"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { courses, isLoading, createCourse, updateCourse, archiveCourse, deleteCourse };
}

export function useTrainingEnrollments(employeeId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: enrollments = [], isLoading } = useQuery({
    queryKey: ["training-enrollments", currentOrg?.id, employeeId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase.from("training_enrollments").select("*").eq("organization_id", currentOrg.id);
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q.order("enrolled_at", { ascending: false });
      if (error) throw error; return (data ?? []) as TrainingEnrollment[];
    },
    enabled: !!currentOrg?.id,
  });

  const createEnrollment = useMutation({
    mutationFn: async (input: { employee_id: string; course_id: string; due_date?: string | null; source?: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("training_enrollments").insert({
        organization_id: currentOrg.id, status: "enrolled",
        assigned_by: u?.user?.id ?? null,
        source: input.source ?? "manual",
        employee_id: input.employee_id,
        course_id: input.course_id,
        due_date: input.due_date ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-enrollments"] }); toast.success("Enrolled"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const bulkEnroll = useMutation({
    mutationFn: async (input: { employee_ids: string[]; course_id: string; due_date?: string | null }) => {
      if (!currentOrg?.id) throw new Error("No org");
      if (input.employee_ids.length === 0) throw new Error("No employees selected");
      const { data: u } = await supabase.auth.getUser();
      const { data: existing } = await supabase
        .from("training_enrollments")
        .select("employee_id,status")
        .eq("organization_id", currentOrg.id)
        .eq("course_id", input.course_id)
        .in("employee_id", input.employee_ids)
        .in("status", ["enrolled", "in_progress"]);
      const skip = new Set((existing ?? []).map((e: any) => e.employee_id));
      const rows = input.employee_ids
        .filter((id) => !skip.has(id))
        .map((id) => ({
          organization_id: currentOrg.id,
          status: "enrolled" as const,
          assigned_by: u?.user?.id ?? null,
          source: "bulk",
          employee_id: id,
          course_id: input.course_id,
          due_date: input.due_date ?? null,
        }));
      if (rows.length === 0) return { created: 0, skipped: skip.size };
      const { error } = await supabase.from("training_enrollments").insert(rows);
      if (error) throw error;
      return { created: rows.length, skipped: skip.size };
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["training-enrollments"] });
      toast.success(`${r.created} enrolled${r.skipped ? ` · ${r.skipped} skipped (already active)` : ""}`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const selfEnroll = useMutation({
    mutationFn: async (input: { employee_id: string; course_id: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("training_enrollments").insert({
        organization_id: currentOrg.id, status: "enrolled",
        assigned_by: u?.user?.id ?? null, source: "self",
        employee_id: input.employee_id, course_id: input.course_id,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-enrollments"] }); toast.success("Enrolled in course"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateEnrollment = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<TrainingEnrollment> }) => {
      const { error } = await supabase.from("training_enrollments").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-enrollments"] }); toast.success("Enrollment updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const startEnrollment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("training_enrollments")
        .update({ status: "in_progress", started_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-enrollments"] }); toast.success("Marked in progress"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const completeEnrollment = useMutation({
    mutationFn: async ({ id, certificateFile, score }: { id: string; certificateFile?: File; score?: number }) => {
      // Look up pass score so we can auto-grade
      const { data: enr } = await supabase
        .from("training_enrollments")
        .select("course_id")
        .eq("id", id)
        .maybeSingle();
      let passScore: number | null = null;
      if (enr?.course_id) {
        const { data: course } = await supabase.from("training_courses").select("pass_score").eq("id", enr.course_id).maybeSingle();
        passScore = (course as any)?.pass_score ?? null;
      }

      let certificate_url: string | null | undefined = undefined;
      if (certificateFile) {
        if (!currentOrg?.id) throw new Error("No org");
        if (certificateFile.size > 50 * 1024 * 1024) throw new Error("Certificate exceeds 50 MB");
        const clean = certificateFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${currentOrg.id}/training-certificates/${id}/${crypto.randomUUID()}-${clean}`;
        const up = await supabase.storage.from("documents").upload(path, certificateFile, {
          contentType: certificateFile.type || undefined, upsert: false,
        });
        if (up.error) throw up.error;
        certificate_url = path;
      }

      const finalStatus: EnrolStatus = (passScore != null && typeof score === "number" && score < passScore)
        ? "failed" : "completed";

      const patch: any = { status: finalStatus, completed_at: new Date().toISOString() };
      if (certificate_url !== undefined) patch.certificate_url = certificate_url;
      if (typeof score === "number") patch.score = score;
      const { error } = await supabase.from("training_enrollments").update(patch).eq("id", id);
      if (error) throw error;
      return { finalStatus };
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["training-enrollments"] });
      toast.success(r.finalStatus === "failed" ? "Recorded as failed (below pass score)" : "Course completed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const dropEnrollment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("training_enrollments").update({ status: "dropped" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["training-enrollments"] }); toast.success("Enrollment dropped"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { enrollments, isLoading, createEnrollment, bulkEnroll, selfEnroll, updateEnrollment, startEnrollment, completeEnrollment, dropEnrollment };
}

export function useCompetencies() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: competencies = [], isLoading } = useQuery({
    queryKey: ["competencies", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase.from("competencies").select("*").eq("organization_id", currentOrg.id).order("category", { nullsFirst: false }).order("name");
      if (error) throw error; return (data ?? []) as Competency[];
    },
    enabled: !!currentOrg?.id,
  });

  const createCompetency = useMutation({
    mutationFn: async (input: Partial<Competency> & { name: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { error } = await supabase.from("competencies").insert({
        organization_id: currentOrg.id, is_active: true, ...input,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["competencies"] }); toast.success("Competency created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { competencies, isLoading, createCompetency };
}

export function useEmployeeCompetencies(employeeId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["employee-competencies", currentOrg?.id, employeeId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase.from("employee_competencies").select("*").eq("organization_id", currentOrg.id);
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q;
      if (error) throw error; return (data ?? []) as EmployeeCompetency[];
    },
    enabled: !!currentOrg?.id,
  });

  const assess = useMutation({
    mutationFn: async (input: { employee_id: string; competency_id: string; level: number; notes?: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("employee_competencies").upsert({
        organization_id: currentOrg.id,
        assessor_user_id: u?.user?.id ?? null,
        assessed_at: new Date().toISOString().slice(0, 10),
        ...input,
      }, { onConflict: "employee_id,competency_id" });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employee-competencies"] }); toast.success("Assessment recorded"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { rows, isLoading, assess };
}
