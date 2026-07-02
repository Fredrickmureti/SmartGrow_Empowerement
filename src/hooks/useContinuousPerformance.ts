/**
 * useContinuousPerformance — Phase A Talent: 1:1s, continuous feedback, kudos.
 *
 * Three independent surfaces backed by the new `one_on_ones`,
 * `one_on_one_talking_points`, `continuous_feedback`, and `kudos` tables.
 * Reads of 1:1s go through the `one_on_ones_visible` view which masks the
 * other side's private notes via security_invoker RLS.
 *
 * Every meaningful write fires a `notifyTalent` event so the receiver hears
 * about it in the bell / /me surfaces without polling.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentEmployee } from "./useCurrentEmployee";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { notifyTalent } from "@/lib/talent/notifications";

export type OneOnOneStatus = "scheduled" | "completed" | "cancelled" | "no_show";
export type FeedbackType = "praise" | "constructive" | "request";
export type FeedbackVisibility = "private" | "manager" | "public";

export interface OneOnOne {
  id: string;
  organization_id: string;
  business_id: string | null;
  manager_id: string;
  employee_id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: OneOnOneStatus;
  recurrence: "none" | "weekly" | "biweekly" | "monthly" | null;
  shared_summary: string | null;
  private_notes_manager: string | null;   // null when not authored by current viewer
  private_notes_employee: string | null;
  action_items: { id: string; text: string; owner: "manager" | "employee"; due?: string | null; done?: boolean }[];
  completed_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
}

export interface TalkingPoint {
  id: string;
  one_on_one_id: string;
  author_role: "manager" | "employee";
  author_user_id: string | null;
  body: string;
  is_addressed: boolean;
  sort_order: number;
  created_at: string;
}

export interface ContinuousFeedback {
  id: string;
  organization_id: string;
  from_user_id: string;
  from_employee_id: string | null;
  to_employee_id: string;
  feedback_type: FeedbackType;
  visibility: FeedbackVisibility;
  body: string;
  competency_id: string | null;
  goal_id: string | null;
  is_anonymous: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

export interface Kudos {
  id: string;
  organization_id: string;
  from_user_id: string;
  from_employee_id: string | null;
  to_employee_id: string;
  body: string;
  value_tag: string | null;
  reaction_count: number;
  created_at: string;
}

// =====================================================================
// 1:1s
// =====================================================================
export function useOneOnOnes(opts: { managerId?: string; employeeId?: string } = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const qc = useQueryClient();
  const { managerId, employeeId } = opts;

  const { data: oneOnOnes = [], isLoading } = useQuery({
    queryKey: ["one-on-ones", currentOrg?.id, managerId ?? null, employeeId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("one_on_ones_visible") as any)
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (managerId) q = q.eq("manager_id", managerId);
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q.order("scheduled_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as OneOnOne[];
    },
    enabled: !!currentOrg?.id,
  });

  const schedule = useMutation({
    mutationFn: async (input: {
      employee_id: string;
      manager_id?: string;
      scheduled_at: string;
      duration_minutes?: number;
      recurrence?: OneOnOne["recurrence"];
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const manager_id = input.manager_id ?? currentEmployee?.id;
      if (!manager_id) throw new Error("Manager record required");
      const { data, error } = await (supabase.from("one_on_ones") as any)
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          manager_id,
          employee_id: input.employee_id,
          scheduled_at: input.scheduled_at,
          duration_minutes: input.duration_minutes ?? 30,
          recurrence: input.recurrence ?? "none",
          created_by: user?.id ?? null,
        })
        .select("id, employee_id, scheduled_at")
        .single();
      if (error) throw error;

      await notifyTalent({
        organizationId: currentOrg.id,
        employeeId: data.employee_id,
        kind: "oneonone.scheduled",
        title: "1:1 scheduled",
        message: `Your 1:1 is scheduled for ${new Date(data.scheduled_at).toLocaleString()}.`,
        link: `/me/one-on-ones/${data.id}`,
        entityType: "one_on_one",
        entityId: data.id,
        priority: 3,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["one-on-ones"] });
      toast.success("1:1 scheduled");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<OneOnOne> }) => {
      const { error } = await (supabase.from("one_on_ones") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["one-on-ones"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const complete = useMutation({
    mutationFn: async ({ id, summary }: { id: string; summary?: string }) => {
      const patch: any = { status: "completed", completed_at: new Date().toISOString() };
      if (summary !== undefined) patch.shared_summary = summary;
      const { error } = await (supabase.from("one_on_ones") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["one-on-ones"] });
      toast.success("1:1 marked complete");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { oneOnOnes, isLoading, schedule, update, complete };
}

export function useOneOnOne(id?: string) {
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data: meeting } = useQuery({
    queryKey: ["one-on-one", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await (supabase.from("one_on_ones_visible") as any)
        .select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return (data ?? null) as OneOnOne | null;
    },
    enabled: !!id,
  });

  const { data: talkingPoints = [] } = useQuery({
    queryKey: ["one-on-one-tp", id],
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await (supabase.from("one_on_one_talking_points") as any)
        .select("*").eq("one_on_one_id", id).order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as TalkingPoint[];
    },
    enabled: !!id,
  });

  const addTalkingPoint = useMutation({
    mutationFn: async (input: { body: string; author_role: "manager" | "employee" }) => {
      if (!id || !meeting) throw new Error("No meeting");
      const sort = talkingPoints.length;
      const { error } = await (supabase.from("one_on_one_talking_points") as any).insert({
        organization_id: meeting.organization_id,
        one_on_one_id: id,
        author_role: input.author_role,
        author_user_id: user?.id ?? null,
        body: input.body,
        sort_order: sort,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["one-on-one-tp", id] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const toggleAddressed = useMutation({
    mutationFn: async ({ tpId, addressed }: { tpId: string; addressed: boolean }) => {
      const { error } = await (supabase.from("one_on_one_talking_points") as any)
        .update({ is_addressed: addressed }).eq("id", tpId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["one-on-one-tp", id] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeTalkingPoint = useMutation({
    mutationFn: async (tpId: string) => {
      const { error } = await (supabase.from("one_on_one_talking_points") as any).delete().eq("id", tpId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["one-on-one-tp", id] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const saveNotes = useMutation({
    mutationFn: async ({ field, value }: { field: "private_notes_manager" | "private_notes_employee" | "shared_summary"; value: string }) => {
      if (!id) throw new Error("No meeting");
      const { error } = await (supabase.from("one_on_ones") as any)
        .update({ [field]: value }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["one-on-one", id] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const saveActionItems = useMutation({
    mutationFn: async (items: OneOnOne["action_items"]) => {
      if (!id) throw new Error("No meeting");
      const { error } = await (supabase.from("one_on_ones") as any)
        .update({ action_items: items }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["one-on-one", id] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { meeting, talkingPoints, addTalkingPoint, toggleAddressed, removeTalkingPoint, saveNotes, saveActionItems };
}

// =====================================================================
// Continuous Feedback
// =====================================================================
export function useContinuousFeedback(opts: { toEmployeeId?: string; fromUserId?: string } = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const qc = useQueryClient();
  const { toEmployeeId, fromUserId } = opts;

  const { data: feedback = [], isLoading } = useQuery({
    queryKey: ["continuous-feedback", currentOrg?.id, toEmployeeId ?? null, fromUserId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("continuous_feedback") as any)
        .select("*").eq("organization_id", currentOrg.id);
      if (toEmployeeId) q = q.eq("to_employee_id", toEmployeeId);
      if (fromUserId) q = q.eq("from_user_id", fromUserId);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as ContinuousFeedback[];
    },
    enabled: !!currentOrg?.id,
  });

  const send = useMutation({
    mutationFn: async (input: {
      to_employee_id: string;
      feedback_type: FeedbackType;
      visibility?: FeedbackVisibility;
      body: string;
      competency_id?: string | null;
      goal_id?: string | null;
      is_anonymous?: boolean;
    }) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not signed in");
      const { data, error } = await (supabase.from("continuous_feedback") as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        from_user_id: user.id,
        from_employee_id: currentEmployee?.id ?? null,
        to_employee_id: input.to_employee_id,
        feedback_type: input.feedback_type,
        visibility: input.visibility ?? "private",
        body: input.body,
        competency_id: input.competency_id ?? null,
        goal_id: input.goal_id ?? null,
        is_anonymous: input.is_anonymous ?? false,
      }).select("id, to_employee_id, feedback_type").single();
      if (error) throw error;

      await notifyTalent({
        organizationId: currentOrg.id,
        employeeId: data.to_employee_id,
        kind: "feedback.received",
        title:
          data.feedback_type === "praise" ? "You received praise"
          : data.feedback_type === "constructive" ? "You received feedback"
          : "Feedback requested",
        message: input.body.slice(0, 140),
        link: `/me/talent/feedback`,
        entityType: "continuous_feedback",
        entityId: data.id,
        priority: data.feedback_type === "praise" ? 4 : 2,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["continuous-feedback"] });
      toast.success("Feedback sent");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const acknowledge = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("continuous_feedback") as any)
        .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user?.id ?? null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["continuous-feedback"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("continuous_feedback") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["continuous-feedback"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { feedback, isLoading, send, acknowledge, remove };
}

// =====================================================================
// Kudos
// =====================================================================
export function useKudos(opts: { toEmployeeId?: string; limit?: number } = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const qc = useQueryClient();
  const { toEmployeeId, limit = 50 } = opts;

  const { data: kudos = [], isLoading } = useQuery({
    queryKey: ["kudos", currentOrg?.id, toEmployeeId ?? null, limit],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("kudos") as any)
        .select("*").eq("organization_id", currentOrg.id);
      if (toEmployeeId) q = q.eq("to_employee_id", toEmployeeId);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as Kudos[];
    },
    enabled: !!currentOrg?.id,
  });

  const send = useMutation({
    mutationFn: async (input: { to_employee_id: string; body: string; value_tag?: string | null }) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not signed in");
      const { data, error } = await (supabase.from("kudos") as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        from_user_id: user.id,
        from_employee_id: currentEmployee?.id ?? null,
        to_employee_id: input.to_employee_id,
        body: input.body,
        value_tag: input.value_tag ?? null,
      }).select("id, to_employee_id").single();
      if (error) throw error;

      await notifyTalent({
        organizationId: currentOrg.id,
        employeeId: data.to_employee_id,
        kind: "kudos.received",
        title: "🎉 You received kudos",
        message: input.body.slice(0, 140),
        link: "/me/talent/feedback",
        entityType: "kudos",
        entityId: data.id,
        priority: 4,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kudos"] });
      toast.success("Kudos sent");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { kudos, isLoading, send };
}