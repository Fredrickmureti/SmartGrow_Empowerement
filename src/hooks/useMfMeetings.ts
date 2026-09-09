/**
 * Group meeting lifecycle (field wave).
 *
 * The authoritative business event is a group meeting: it is opened for a date,
 * attendance is recorded, activity done at it is stamped with it, and it is
 * completed (or postponed / recorded as missed) server-side. Every lifecycle
 * rule lives in the database RPCs — this hook only calls them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

export type MfMeetingStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "postponed"
  | "missed";

export interface MfGroupMeeting {
  id: string;
  business_id: string;
  branch_id: string | null;
  group_id: string;
  loan_officer_id: string | null;
  scheduled_on: string;
  scheduled_time: string | null;
  meeting_place: string | null;
  status: MfMeetingStatus;
  opened_at: string | null;
  opened_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  notes: string | null;
  postponed_to: string | null;
  next_scheduled_on: string | null;
  created_at: string;
}

export type MfAttendanceStatus = "present" | "absent" | "excused";

export interface MfMeetingAttendance {
  id: string;
  meeting_id: string;
  client_id: string;
  status: MfAttendanceStatus;
  note: string | null;
}

const MEETING_SELECT =
  "id,business_id,branch_id,group_id,loan_officer_id,scheduled_on,scheduled_time,meeting_place,status,opened_at,opened_by,closed_at,closed_by,notes,postponed_to,next_scheduled_on,created_at";

export const MEETING_STATUS_LABEL: Record<MfMeetingStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  postponed: "Postponed",
  missed: "Missed",
};

/** ISO weekday (1 = Monday .. 7 = Sunday) for a yyyy-mm-dd date string. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Meetings recorded between two dates (inclusive) for the current institution. */
export function useMfGroupMeetings(options?: {
  from?: string;
  to?: string;
  groupId?: string | null;
}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const from = options?.from ?? todayIso();
  const to = options?.to ?? from;
  const groupId = options?.groupId ?? null;

  const query = useQuery({
    queryKey: ["mf-group-meetings", businessId, from, to, groupId],
    queryFn: async () => {
      if (!businessId) return [] as MfGroupMeeting[];
      let q = supabase
        .from("mf_group_meetings")
        .select(MEETING_SELECT)
        .eq("business_id", businessId)
        .gte("scheduled_on", from)
        .lte("scheduled_on", to)
        .order("scheduled_on", { ascending: true })
        .order("scheduled_time", { ascending: true, nullsFirst: true });
      if (groupId) q = q.eq("group_id", groupId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfGroupMeeting[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-group-meetings"] });
    queryClient.invalidateQueries({ queryKey: ["mf-meeting-attendance"] });
    queryClient.invalidateQueries({ queryKey: ["mf-repayment-batches"] });
    queryClient.invalidateQueries({ queryKey: ["mf-meeting-summary"] });
  };

  const openMeeting = useMutation({
    mutationFn: async (input: { groupId: string; meetingOn: string }) => {
      const { data, error } = await supabase.rpc("mf_open_group_meeting", {
        p_group_id: input.groupId,
        p_meeting_on: input.meetingOn,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Meeting opened");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not open the meeting")),
  });

  const completeMeeting = useMutation({
    mutationFn: async (input: { meetingId: string; notes?: string | null }) => {
      const { data, error } = await supabase.rpc("mf_complete_group_meeting", {
        p_meeting_id: input.meetingId,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as {
        next_scheduled_on: string | null;
        has_recurring_schedule: boolean;
      };
    },
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result?.next_scheduled_on
          ? `Meeting completed. Next meeting: ${result.next_scheduled_on}`
          : "Meeting completed. This group has no regular meeting day, so set the next date yourself.",
      );
    },
    onError: (e) =>
      toast.error(lendingErrorMessage(e, "Could not complete the meeting")),
  });

  const postponeMeeting = useMutation({
    mutationFn: async (input: {
      meetingId: string;
      newDate: string | null;
      reason?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("mf_postpone_group_meeting", {
        p_meeting_id: input.meetingId,
        p_new_date: input.newDate,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data as { status: string; next_scheduled_on: string | null };
    },
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result?.status === "missed"
          ? "Meeting recorded as missed"
          : `Meeting postponed to ${result?.next_scheduled_on ?? "a new date"}`,
      );
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not change the meeting")),
  });

  return {
    meetings: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    openMeeting,
    completeMeeting,
    postponeMeeting,
  };
}

/** Attendance for one meeting. */
export function useMfMeetingAttendance(meetingId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-meeting-attendance", meetingId],
    queryFn: async () => {
      if (!meetingId) return [] as MfMeetingAttendance[];
      const { data, error } = await supabase
        .from("mf_meeting_attendance")
        .select("id,meeting_id,client_id,status,note")
        .eq("meeting_id", meetingId);
      if (error) throw error;
      return (data ?? []) as MfMeetingAttendance[];
    },
    enabled: !!meetingId,
  });

  const setAttendance = useMutation({
    mutationFn: async (input: {
      clientId: string;
      status: MfAttendanceStatus;
      note?: string | null;
    }) => {
      if (!meetingId) throw new Error("No meeting selected");
      const { error } = await supabase
        .from("mf_meeting_attendance")
        .upsert(
          {
            meeting_id: meetingId,
            client_id: input.clientId,
            status: input.status,
            note: input.note ?? null,
          },
          { onConflict: "meeting_id,client_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-meeting-attendance"] });
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not save attendance")),
  });

  return {
    attendance: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    setAttendance,
  };
}

/**
 * What this meeting produced: clients registered at it and the money collected
 * through the batch(es) stamped with it. Read-only — every one of these rows is
 * written by its own authoritative path (client registration, repayment RPC).
 */
export interface MfMeetingSummary {
  onboarded: Array<{ id: string; client_number: string; full_name: string }>;
  collectedTotal: number;
  receiptCount: number;
}

export function useMfMeetingSummary(meetingId: string | null) {
  const query = useQuery({
    queryKey: ["mf-meeting-summary", meetingId],
    enabled: !!meetingId,
    queryFn: async (): Promise<MfMeetingSummary> => {
      if (!meetingId) return { onboarded: [], collectedTotal: 0, receiptCount: 0 };

      const { data: clients, error: clientsError } = await supabase
        .from("mf_clients")
        .select("id,client_number,full_name")
        .eq("onboarded_meeting_id", meetingId)
        .order("created_at", { ascending: true });
      if (clientsError) throw clientsError;

      const { data: batches, error: batchesError } = await supabase
        .from("mf_repayment_batches")
        .select("id")
        .eq("meeting_id", meetingId);
      if (batchesError) throw batchesError;

      const batchIds = (batches ?? []).map((b) => b.id as string);
      let collectedTotal = 0;
      let receiptCount = 0;
      if (batchIds.length > 0) {
        const { data: receipts, error: receiptsError } = await supabase
          .from("mf_repayments")
          .select("amount,status")
          .in("batch_id", batchIds);
        if (receiptsError) throw receiptsError;
        for (const r of receipts ?? []) {
          if ((r as { status: string }).status === "reversed") continue;
          collectedTotal += Number((r as { amount: number }).amount ?? 0);
          receiptCount += 1;
        }
      }

      return {
        onboarded: (clients ?? []) as MfMeetingSummary["onboarded"],
        collectedTotal,
        receiptCount,
      };
    },
  });

  return { summary: query.data ?? null, isLoading: query.isLoading };
}
