/**
 * Branch operational day.
 *
 * The branch's trading day is a real record: it is opened with a cash count,
 * money is recorded against it, and it is closed with a second count that the
 * database compares against what the ledger says should be there. Every rule
 * — who may open, which dates are allowed, the tolerance, the over/short
 * posting, the reopen authority — lives in the database RPCs. This hook only
 * reads the rows and calls them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

export type BranchDayStatus = "open" | "closed";

export interface BranchOperationalDay {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string;
  business_date: string;
  status: BranchDayStatus;
  opening_cash: number | null;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  variance_reason: string | null;
  variance_journal_entry_id: string | null;
  notes: string | null;
  opened_by: string | null;
  opened_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  reopened_count: number | null;
}

export interface BranchDayEvent {
  id: string;
  operational_day_id: string;
  branch_id: string;
  business_date: string;
  event_type: string;
  actor_id: string | null;
  opening_cash: number | null;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  reason: string | null;
  event_at: string;
}

const DAY_SELECT =
  "id,organization_id,business_id,branch_id,business_date,status,opening_cash,expected_cash,counted_cash,variance,variance_reason,variance_journal_entry_id,notes,opened_by,opened_at,closed_by,closed_at,reopened_count";

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Day register: the branch's days, most recent first. */
export function useBranchDays(options?: {
  branchId?: string | null;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const branchId = options?.branchId ?? null;

  const query = useQuery({
    queryKey: [
      "branch-days",
      businessId,
      branchId,
      options?.from ?? null,
      options?.to ?? null,
    ],
    queryFn: async () => {
      if (!businessId) return [] as BranchOperationalDay[];
      let q = supabase
        .from("branch_operational_days")
        .select(DAY_SELECT)
        .eq("business_id", businessId)
        .order("business_date", { ascending: false })
        .limit(options?.limit ?? 60);
      if (branchId) q = q.eq("branch_id", branchId);
      if (options?.from) q = q.gte("business_date", options.from);
      if (options?.to) q = q.lte("business_date", options.to);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as BranchOperationalDay[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["branch-days"] });
    queryClient.invalidateQueries({ queryKey: ["branch-day-events"] });
    queryClient.invalidateQueries({ queryKey: ["branch-day-expected-cash"] });
  };

  const openDay = useMutation({
    mutationFn: async (input: {
      branchId: string;
      businessDate?: string | null;
      openingCash?: number;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("open_branch_day", {
        p_branch_id: input.branchId,
        p_business_date: input.businessDate ?? null,
        p_opening_cash: input.openingCash ?? 0,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Day opened");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not open the day")),
  });

  const closeDay = useMutation({
    mutationFn: async (input: {
      dayId: string;
      countedCash: number;
      varianceReason?: string | null;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("close_branch_day", {
        p_day_id: input.dayId,
        p_counted_cash: input.countedCash,
        p_variance_reason: input.varianceReason ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Day closed");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not close the day")),
  });

  const reopenDay = useMutation({
    mutationFn: async (input: { dayId: string; reason: string }) => {
      const { data, error } = await supabase.rpc("reopen_branch_day", {
        p_day_id: input.dayId,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Day reopened");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not reopen the day")),
  });

  return {
    days: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    openDay,
    closeDay,
    reopenDay,
  };
}

/** The single open day for a branch, if there is one. */
export function useOpenBranchDay(branchId: string | null | undefined) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  return useQuery({
    queryKey: ["branch-days", "open", businessId, branchId ?? null],
    queryFn: async () => {
      if (!businessId || !branchId) return null;
      const { data, error } = await supabase
        .from("branch_operational_days")
        .select(DAY_SELECT)
        .eq("business_id", businessId)
        .eq("branch_id", branchId)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return (data as BranchOperationalDay | null) ?? null;
    },
    enabled: !!businessId && !!branchId,
  });
}

/** What the ledger says should be in the branch's cash box right now. */
export function useExpectedCash(dayId: string | null | undefined) {
  return useQuery({
    queryKey: ["branch-day-expected-cash", dayId ?? null],
    queryFn: async () => {
      if (!dayId) return null;
      const { data, error } = await supabase.rpc("branch_day_expected_cash", {
        p_day_id: dayId,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    enabled: !!dayId,
    staleTime: 15_000,
  });
}

/** Append-only history for one day. */
export function useBranchDayEvents(dayId: string | null | undefined) {
  return useQuery({
    queryKey: ["branch-day-events", dayId ?? null],
    queryFn: async () => {
      if (!dayId) return [] as BranchDayEvent[];
      const { data, error } = await supabase
        .from("branch_day_events")
        .select(
          "id,operational_day_id,branch_id,business_date,event_type,actor_id,opening_cash,expected_cash,counted_cash,variance,reason,event_at",
        )
        .eq("operational_day_id", dayId)
        .order("event_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as BranchDayEvent[];
    },
    enabled: !!dayId,
  });
}
