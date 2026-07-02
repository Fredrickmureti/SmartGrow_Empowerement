/**
 * useCalibration — Phase C Talent: calibration sessions, participants,
 * and adjustment proposals/decisions.
 *
 * Backed by `calibration_sessions`, `calibration_session_participants`,
 * `calibration_adjustments`, and the `talent_calibration_apply_adjustment` and
 * `talent_bulk_create_reviews` RPCs.
 *
 * RLS:
 *  - HR admins/owners manage everything in their org.
 *  - Session participants can read sessions they were invited to and propose
 *    adjustments within them.
 *  - Only HR can approve (apply) or reject adjustments.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeError } from "@/services/resilience";

export type CalibrationSessionStatus = "scheduled" | "in_progress" | "completed" | "cancelled";
export type CalibrationParticipantRole = "facilitator" | "manager" | "hr" | "observer";
export type AdjustmentDecision = "pending" | "approved" | "rejected" | "withdrawn";

export interface CalibrationSession {
  id: string;
  organization_id: string;
  cycle_id: string;
  name: string;
  scheduled_at: string | null;
  location: string | null;
  facilitator_user_id: string | null;
  status: CalibrationSessionStatus;
  notes: string | null;
  scope_department_ids: string[] | null;
  created_by: string;
  created_at: string;
}

export interface CalibrationParticipant {
  id: string;
  session_id: string;
  organization_id: string;
  participant_user_id: string;
  role: CalibrationParticipantRole;
  attended: boolean | null;
}

export interface CalibrationAdjustment {
  id: string;
  organization_id: string;
  session_id: string | null;
  cycle_id: string;
  review_id: string;
  employee_id: string;
  original_rating: number | null;
  proposed_rating: number;
  rationale: string;
  proposed_by: string;
  decision: AdjustmentDecision;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
}

export function useCalibrationSessions(cycleId?: string) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["calibration-sessions", currentOrg?.id, cycleId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("calibration_sessions") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("scheduled_at", { ascending: false, nullsFirst: false });
      if (cycleId) q = q.eq("cycle_id", cycleId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CalibrationSession[];
    },
    enabled: !!currentOrg?.id,
  });

  const createSession = useMutation({
    mutationFn: async (input: {
      cycle_id: string;
      name: string;
      scheduled_at?: string | null;
      location?: string | null;
      facilitator_user_id?: string | null;
      notes?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      if (!user?.id) throw new Error("Not authenticated");
      const { data, error } = await (supabase.from("calibration_sessions") as any)
        .insert({
          organization_id: currentOrg.id,
          cycle_id: input.cycle_id,
          name: input.name,
          scheduled_at: input.scheduled_at ?? null,
          location: input.location ?? null,
          facilitator_user_id: input.facilitator_user_id ?? user.id,
          notes: input.notes ?? null,
          created_by: user.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as CalibrationSession;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calibration-sessions"] });
      toast.success("Calibration session scheduled");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateSession = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<CalibrationSession> }) => {
      const { error } = await (supabase.from("calibration_sessions") as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calibration-sessions"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteSession = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("calibration_sessions") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calibration-sessions"] });
      toast.success("Session removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { sessions, isLoading, createSession, updateSession, deleteSession };
}

export function useCalibrationParticipants(sessionId?: string) {
  const qc = useQueryClient();

  const { data: participants = [], isLoading } = useQuery({
    queryKey: ["calibration-participants", sessionId ?? null],
    queryFn: async () => {
      if (!sessionId) return [];
      const { data, error } = await (supabase.from("calibration_session_participants") as any)
        .select("*")
        .eq("session_id", sessionId);
      if (error) throw error;
      return (data ?? []) as CalibrationParticipant[];
    },
    enabled: !!sessionId,
  });

  const addParticipant = useMutation({
    mutationFn: async (input: {
      session_id: string;
      organization_id: string;
      participant_user_id: string;
      role?: CalibrationParticipantRole;
    }) => {
      const { error } = await (supabase.from("calibration_session_participants") as any).insert({
        session_id: input.session_id,
        organization_id: input.organization_id,
        participant_user_id: input.participant_user_id,
        role: input.role ?? "manager",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calibration-participants"] });
      toast.success("Participant added");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const removeParticipant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("calibration_session_participants") as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calibration-participants"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { participants, isLoading, addParticipant, removeParticipant };
}

export function useCalibrationAdjustments(opts: { cycleId?: string; sessionId?: string }) {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: adjustments = [], isLoading } = useQuery({
    queryKey: ["calibration-adjustments", currentOrg?.id, opts.cycleId ?? null, opts.sessionId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q: any = (supabase.from("calibration_adjustments") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (opts.cycleId) q = q.eq("cycle_id", opts.cycleId);
      if (opts.sessionId) q = q.eq("session_id", opts.sessionId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CalibrationAdjustment[];
    },
    enabled: !!currentOrg?.id,
  });

  const propose = useMutation({
    mutationFn: async (input: {
      session_id: string | null;
      cycle_id: string;
      review_id: string;
      employee_id: string;
      original_rating: number | null;
      proposed_rating: number;
      rationale: string;
    }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      if (!user?.id) throw new Error("Not authenticated");
      const { error } = await (supabase.from("calibration_adjustments") as any).insert({
        organization_id: currentOrg.id,
        session_id: input.session_id,
        cycle_id: input.cycle_id,
        review_id: input.review_id,
        employee_id: input.employee_id,
        original_rating: input.original_rating,
        proposed_rating: input.proposed_rating,
        rationale: input.rationale,
        proposed_by: user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calibration-adjustments"] });
      toast.success("Adjustment proposed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const apply = useMutation({
    mutationFn: async (adjustmentId: string) => {
      const { error } = await (supabase as any).rpc("talent_calibration_apply_adjustment", {
        _adjustment_id: adjustmentId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calibration-adjustments"] });
      qc.invalidateQueries({ queryKey: ["reviews"] });
      toast.success("Adjustment applied");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const reject = useMutation({
    mutationFn: async (adjustmentId: string) => {
      if (!user?.id) throw new Error("Not authenticated");
      const { error } = await (supabase.from("calibration_adjustments") as any)
        .update({ decision: "rejected", decided_by: user.id, decided_at: new Date().toISOString() })
        .eq("id", adjustmentId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calibration-adjustments"] });
      toast.success("Adjustment rejected");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { adjustments, isLoading, propose, apply, reject };
}

export function useBulkCreateReviews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cycle_id: string; review_type: "self" | "manager" }) => {
      const { data, error } = await (supabase as any).rpc("talent_bulk_create_reviews", {
        _cycle_id: input.cycle_id,
        _review_type: input.review_type,
      });
      if (error) throw error;
      const count = Array.isArray(data) ? (data[0]?.created_count ?? 0) : 0;
      return count as number;
    },
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["reviews"] });
      toast.success(`${count} review${count === 1 ? "" : "s"} created`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });
}
