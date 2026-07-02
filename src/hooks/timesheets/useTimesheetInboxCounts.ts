/**
 * useTimesheetInboxCounts — single source of truth for Timesheets "work waiting".
 *
 * Returns the count of submitted timesheet_submissions awaiting approval in
 * the current org/business scope. Mirrors useAttendanceInboxCounts so the
 * sub-nav badge, the manager triage banner, and HRDashboard's InboxCard all
 * read the same number.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface TimesheetInboxCounts {
  pendingApprovals: number;
  total: number;
}

const ZERO: TimesheetInboxCounts = { pendingApprovals: 0, total: 0 };

export function useTimesheetInboxCounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const queryKey = ["timesheet-inbox-counts", currentOrg?.id, currentBusiness?.id];

  const { data = ZERO, isLoading } = useQuery<TimesheetInboxCounts>({
    queryKey,
    enabled: !!currentOrg?.id,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!currentOrg?.id) return ZERO;
      let q = supabase
        .from("timesheet_submissions" as any)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("status", "submitted");
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { count } = await q;
      const pendingApprovals = count ?? 0;
      return { pendingApprovals, total: pendingApprovals };
    },
  });

  useEffect(() => {
    if (!currentOrg?.id) return;
    if (import.meta.env.VITE_DISABLE_REALTIME === "true") return;
    const filter = `organization_id=eq.${currentOrg.id}`;
    const topic = `ts-inbox-${currentOrg.id}-${currentBusiness?.id ?? "all"}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(topic)
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "timesheet_submissions", filter },
        () => qc.invalidateQueries({ queryKey }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id, currentBusiness?.id]);

  return { counts: data, isLoading };
}
