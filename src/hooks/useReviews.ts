/**
 * useReviews — Phase 2 Talent: Performance Reviews lifecycle.
 *
 * Models the multi-participant review cycle:
 *   - review_templates → sections → questions (HR designs)
 *   - performance_reviews per (employee, reviewer, role) (one row per fill-in)
 *   - review_participants tracks invitations
 *   - review_responses are the actual answers (per review_id)
 *
 * Launching a review for an employee creates one performance_reviews row
 * per included audience (self, manager, peer, skip_level) — each becomes
 * its own assignment for that reviewer. Responses are stored against the
 * specific review_id so participants don't overwrite each other.
 *
 * Notifications fire on: review invited, review submitted, review acknowledged.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { notifyTalent } from "@/lib/talent/notifications";

export type ReviewRole = "self" | "manager" | "peer" | "skip_level" | "upward";
export type ReviewStatus =
  | "draft"
  | "in_progress"
  | "submitted"
  | "calibrated"
  | "signed_off"
  | "acknowledged"
  | "cancelled";

export interface ReviewTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  includes_self: boolean;
  includes_manager: boolean;
  includes_peer: boolean;
  includes_skip_level: boolean;
  rating_scale: any;
}

export interface ReviewTemplateSection {
  id: string;
  template_id: string;
  title: string;
  description: string | null;
  weight: number;
  sort_order: number;
}

export interface ReviewTemplateQuestion {
  id: string;
  template_id: string;
  section_id: string | null;
  prompt: string;
  question_type: string;          // 'rating' | 'text' | 'rating_text' | 'competency'
  audiences: string[];            // subset of ReviewRole
  competency_id: string | null;
  is_required: boolean;
  sort_order: number;
}

export interface PerformanceReview {
  id: string;
  organization_id: string;
  cycle_id: string;
  employee_id: string;
  reviewer_user_id: string;
  review_type: string;            // ReviewRole
  template_id: string | null;
  status: ReviewStatus;
  due_at: string | null;
  overall_rating: number | null;
  final_rating: number | null;
  strengths: string | null;
  development_areas: string | null;
  summary: string | null;
  calibration_notes: string | null;
  submitted_at: string | null;
  signed_off_at: string | null;
  signed_off_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

export interface ReviewResponse {
  id: string;
  review_id: string;
  question_id: string | null;
  competency_id: string | null;
  goal_id: string | null;
  rating: number | null;
  comment: string | null;
}

// =====================================================================
// Templates
// =====================================================================
export function useReviewTemplates() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["review-templates", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await (supabase.from("review_templates") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReviewTemplate[];
    },
    enabled: !!currentOrg?.id,
  });

  const createTemplate = useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string;
      includes_self?: boolean;
      includes_manager?: boolean;
      includes_peer?: boolean;
      includes_skip_level?: boolean;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { data, error } = await (supabase.from("review_templates") as any)
        .insert({
          organization_id: currentOrg.id,
          name: input.name,
          description: input.description ?? null,
          includes_self: input.includes_self ?? true,
          includes_manager: input.includes_manager ?? true,
          includes_peer: input.includes_peer ?? false,
          includes_skip_level: input.includes_skip_level ?? false,
          is_active: true,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review-templates"] });
      toast.success("Template created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateTemplate = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<ReviewTemplate> }) => {
      const { error } = await (supabase.from("review_templates") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review-templates"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { templates, isLoading, createTemplate, updateTemplate };
}

export function useReviewTemplate(templateId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: template } = useQuery({
    queryKey: ["review-template", templateId],
    queryFn: async () => {
      if (!templateId) return null;
      const { data, error } = await (supabase.from("review_templates") as any)
        .select("*")
        .eq("id", templateId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as ReviewTemplate | null;
    },
    enabled: !!templateId,
  });

  const { data: sections = [] } = useQuery({
    queryKey: ["review-template-sections", templateId],
    queryFn: async () => {
      if (!templateId) return [];
      const { data, error } = await (supabase.from("review_template_sections") as any)
        .select("*")
        .eq("template_id", templateId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewTemplateSection[];
    },
    enabled: !!templateId,
  });

  const { data: questions = [] } = useQuery({
    queryKey: ["review-template-questions", templateId],
    queryFn: async () => {
      if (!templateId) return [];
      const { data, error } = await (supabase.from("review_template_questions") as any)
        .select("*")
        .eq("template_id", templateId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewTemplateQuestion[];
    },
    enabled: !!templateId,
  });

  const addSection = useMutation({
    mutationFn: async (input: { title: string; description?: string; weight?: number }) => {
      if (!templateId || !currentOrg?.id) throw new Error("Missing template");
      const sort = sections.length;
      const { error } = await (supabase.from("review_template_sections") as any).insert({
        organization_id: currentOrg.id,
        template_id: templateId,
        title: input.title,
        description: input.description ?? null,
        weight: input.weight ?? 1,
        sort_order: sort,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review-template-sections", templateId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeSection = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("review_template_sections") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review-template-sections", templateId] });
      qc.invalidateQueries({ queryKey: ["review-template-questions", templateId] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const addQuestion = useMutation({
    mutationFn: async (input: {
      section_id: string | null;
      prompt: string;
      question_type?: string;
      audiences?: string[];
      is_required?: boolean;
      competency_id?: string | null;
    }) => {
      if (!templateId || !currentOrg?.id) throw new Error("Missing template");
      const sort = questions.filter((q) => q.section_id === input.section_id).length;
      const { error } = await (supabase.from("review_template_questions") as any).insert({
        organization_id: currentOrg.id,
        template_id: templateId,
        section_id: input.section_id,
        prompt: input.prompt,
        question_type: input.question_type ?? "rating_text",
        audiences: input.audiences ?? ["self", "manager"],
        is_required: input.is_required ?? true,
        competency_id: input.competency_id ?? null,
        sort_order: sort,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review-template-questions", templateId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeQuestion = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("review_template_questions") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review-template-questions", templateId] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { template, sections, questions, addSection, removeSection, addQuestion, removeQuestion };
}

// =====================================================================
// Reviews (per-participant assignments)
// =====================================================================
export function useReviews(opts: { cycleId?: string; employeeId?: string; reviewerUserId?: string } = {}) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();
  const { cycleId, employeeId, reviewerUserId } = opts;

  const { data: reviews = [], isLoading } = useQuery({
    queryKey: ["performance-reviews", currentOrg?.id, cycleId ?? null, employeeId ?? null, reviewerUserId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("performance_reviews") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (cycleId) q = q.eq("cycle_id", cycleId);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (reviewerUserId) q = q.eq("reviewer_user_id", reviewerUserId);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PerformanceReview[];
    },
    enabled: !!currentOrg?.id,
  });

  /**
   * Launch a review cycle for a set of employees: for each employee creates
   * one performance_reviews row per audience the template enables. Self →
   * employee.user_id, manager → employee.manager_id → employees.user_id.
   * Notifies each reviewer.
   */
  const launchReviews = useMutation({
    mutationFn: async (input: {
      cycle_id: string;
      template_id: string;
      employee_ids: string[];
      due_at?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");

      const { data: tpl, error: tErr } = await (supabase.from("review_templates") as any)
        .select("*")
        .eq("id", input.template_id)
        .maybeSingle();
      if (tErr || !tpl) throw new Error("Template not found");

      const { data: emps, error: eErr } = await supabase
        .from("v_employees_canonical")
        .select("id, user_id, first_name, last_name, manager_id")
        .in("id", input.employee_ids);
      if (eErr) throw eErr;

      const managerIds = Array.from(new Set((emps ?? []).map((e: any) => e.manager_id).filter(Boolean)));
      const managerMap = new Map<string, string | null>();
      if (managerIds.length) {
        const { data: mgrs } = await supabase
          .from("v_employees_canonical")
          .select("id, user_id")
          .in("id", managerIds as string[]);
        (mgrs ?? []).forEach((m: any) => managerMap.set(m.id, m.user_id ?? null));
      }

      const rows: any[] = [];
      const notes: Array<{ employeeId: string; reviewerUserId: string; role: ReviewRole; title: string }> = [];

      for (const emp of emps ?? []) {
        if (tpl.includes_self && emp.user_id) {
          rows.push({
            organization_id: currentOrg.id,
            cycle_id: input.cycle_id,
            employee_id: emp.id,
            reviewer_user_id: emp.user_id,
            review_type: "self",
            template_id: input.template_id,
            status: "draft",
            due_at: input.due_at ?? null,
          });
          notes.push({ employeeId: emp.id, reviewerUserId: emp.user_id, role: "self", title: `Self review: ${tpl.name}` });
        }
        if (tpl.includes_manager && emp.manager_id) {
          const mgrUser = managerMap.get(emp.manager_id);
          if (mgrUser) {
            rows.push({
              organization_id: currentOrg.id,
              cycle_id: input.cycle_id,
              employee_id: emp.id,
              reviewer_user_id: mgrUser,
              review_type: "manager",
              template_id: input.template_id,
              status: "draft",
              due_at: input.due_at ?? null,
            });
            notes.push({
              employeeId: emp.id,
              reviewerUserId: mgrUser,
              role: "manager",
              title: `Manager review of ${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim(),
            });
          }
        }
      }

      if (rows.length === 0) return { created: 0 };

      const { data: inserted, error: insErr } = await (supabase.from("performance_reviews") as any)
        .insert(rows)
        .select("id, employee_id, reviewer_user_id, review_type");
      if (insErr) throw insErr;

      // Notify each reviewer
      await Promise.all(
        (inserted ?? []).map(async (r: any) => {
          const note = notes.find(
            (n) => n.employeeId === r.employee_id && n.reviewerUserId === r.reviewer_user_id && n.role === r.review_type,
          );
          await notifyTalent({
            organizationId: currentOrg.id,
            userId: r.reviewer_user_id,
            kind: "review.invited",
            title: note?.title ?? "Review assigned",
            message: `You've been invited to complete a ${r.review_type} review. Due ${input.due_at ?? "soon"}.`,
            link: r.review_type === "self" ? `/me/talent/reviews/${r.id}` : `/hr/talent/reviews/${r.id}`,
            entityType: "performance_review",
            entityId: r.id,
            priority: 2,
          });
        }),
      );

      return { created: inserted?.length ?? 0 };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["performance-reviews"] });
      toast.success(`Launched ${res?.created ?? 0} review${res?.created === 1 ? "" : "s"}`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { reviews, isLoading, launchReviews };
}

// =====================================================================
// Single review (fill-in, submit, sign-off, acknowledge)
// =====================================================================
export function useReview(reviewId?: string) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: review, isLoading } = useQuery({
    queryKey: ["performance-review", reviewId],
    queryFn: async () => {
      if (!reviewId) return null;
      const { data, error } = await (supabase.from("performance_reviews") as any)
        .select("*")
        .eq("id", reviewId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as PerformanceReview | null;
    },
    enabled: !!reviewId,
  });

  const { data: questions = [] } = useQuery({
    queryKey: ["review-questions-for-review", review?.template_id],
    queryFn: async () => {
      if (!review?.template_id) return [];
      const { data, error } = await (supabase.from("review_template_questions") as any)
        .select("*")
        .eq("template_id", review.template_id)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewTemplateQuestion[];
    },
    enabled: !!review?.template_id,
  });

  const { data: sections = [] } = useQuery({
    queryKey: ["review-sections-for-review", review?.template_id],
    queryFn: async () => {
      if (!review?.template_id) return [];
      const { data, error } = await (supabase.from("review_template_sections") as any)
        .select("*")
        .eq("template_id", review.template_id)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewTemplateSection[];
    },
    enabled: !!review?.template_id,
  });

  const { data: responses = [] } = useQuery({
    queryKey: ["review-responses", reviewId],
    queryFn: async () => {
      if (!reviewId) return [];
      const { data, error } = await (supabase.from("review_responses") as any)
        .select("*")
        .eq("review_id", reviewId);
      if (error) throw error;
      return (data ?? []) as ReviewResponse[];
    },
    enabled: !!reviewId,
  });

  const saveResponse = useMutation({
    mutationFn: async (input: { question_id: string; rating?: number | null; comment?: string | null }) => {
      if (!review || !currentOrg?.id) throw new Error("No review loaded");
      const existing = responses.find((r) => r.question_id === input.question_id);
      if (existing) {
        const { error } = await (supabase.from("review_responses") as any)
          .update({ rating: input.rating ?? null, comment: input.comment ?? null })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase.from("review_responses") as any).insert({
          organization_id: currentOrg.id,
          review_id: review.id,
          question_id: input.question_id,
          rating: input.rating ?? null,
          comment: input.comment ?? null,
        });
        if (error) throw error;
      }
      // mark review as in_progress
      if (review.status === "draft") {
        await (supabase.from("performance_reviews") as any)
          .update({ status: "in_progress" })
          .eq("id", review.id);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review-responses", reviewId] });
      qc.invalidateQueries({ queryKey: ["performance-review", reviewId] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const submitReview = useMutation({
    mutationFn: async (input: { overall_rating?: number | null; summary?: string | null; strengths?: string | null; development_areas?: string | null }) => {
      if (!review) throw new Error("No review");
      // Server-enforced: only the assigned reviewer may submit; protected
      // columns (submitted_at, status='submitted') are gated by trigger.
      const { error } = await (supabase as any).rpc("talent_submit_review", {
        _review_id: review.id,
        _overall_rating: input.overall_rating ?? null,
        _summary: input.summary ?? null,
        _strengths: input.strengths ?? null,
        _development_areas: input.development_areas ?? null,
      });
      if (error) throw error;

      if (review.review_type !== "self") {
        await notifyTalent({
          organizationId: review.organization_id,
          employeeId: review.employee_id,
          kind: "review.submitted",
          title: "A review about you was submitted",
          message: `A ${review.review_type} review has been submitted for this cycle.`,
          link: `/me/talent/reviews/${review.id}`,
          entityType: "performance_review",
          entityId: review.id,
          priority: 2,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["performance-review", reviewId] });
      qc.invalidateQueries({ queryKey: ["performance-reviews"] });
      toast.success("Review submitted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const signOff = useMutation({
    mutationFn: async (input: { final_rating?: number | null; calibration_notes?: string | null }) => {
      if (!review || !user) throw new Error("Missing");
      // Server-enforced: manager-of-employee OR HR admin/owner.
      const { error } = await (supabase as any).rpc("talent_sign_off_review", {
        _review_id: review.id,
        _final_rating: input.final_rating ?? null,
        _calibration_notes: input.calibration_notes ?? null,
      });
      if (error) throw error;

      await notifyTalent({
        organizationId: review.organization_id,
        employeeId: review.employee_id,
        kind: "review.submitted",
        title: "Your review is ready for sign-off",
        message: "Please review and acknowledge.",
        link: `/me/talent/reviews/${review.id}`,
        entityType: "performance_review",
        entityId: review.id,
        priority: 1,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["performance-review", reviewId] });
      toast.success("Signed off");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const acknowledge = useMutation({
    mutationFn: async () => {
      if (!review) throw new Error("No review");
      // Server-enforced: only the reviewed employee may acknowledge.
      const { error } = await (supabase as any).rpc("talent_acknowledge_review", {
        _review_id: review.id,
      });
      if (error) throw error;

      await notifyTalent({
        organizationId: review.organization_id,
        userId: review.reviewer_user_id,
        kind: "review.acknowledged",
        title: "Review acknowledged",
        message: "The employee has acknowledged your review.",
        link: `/hr/talent/reviews/${review.id}`,
        entityType: "performance_review",
        entityId: review.id,
        priority: 3,
      });

    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["performance-review", reviewId] });
      toast.success("Acknowledged");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { review, sections, questions, responses, isLoading, saveResponse, submitReview, signOff, acknowledge };
}
