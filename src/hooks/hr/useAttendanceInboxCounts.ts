/**
 * useAttendanceInboxCounts — single source of truth for HR Attendance "work waiting".
 *
 * Aggregates pending corrections, pending overtime requests, and disabled (unverified)
 * hardware devices into one badge count consumed by the sub-nav, the command-center
 * inbox card, and the HR shell sidebar.
 *
 * Read-only, org+business scoped, RLS-respected.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface AttendanceInboxCounts {
  corrections: number;
  overtime: number;
  devicesDisabled: number;
  devicesStale: number;
  total: number;
}

const ZERO: AttendanceInboxCounts = {
  corrections: 0,
  overtime: 0,
  devicesDisabled: 0,
  devicesStale: 0,
  total: 0,
};

export function useAttendanceInboxCounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const queryKey = ["attendance-inbox-counts", currentOrg?.id, currentBusiness?.id];

  const { data = ZERO, isLoading } = useQuery<AttendanceInboxCounts>({
    queryKey,
    enabled: !!currentOrg?.id,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!currentOrg?.id) return ZERO;

      const scope = (q: any) => {
        let r = q.eq("organization_id", currentOrg.id);
        if (currentBusiness?.id) r = r.eq("business_id", currentBusiness.id);
        return r;
      };

      const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const [corrRes, otRes, devRes, devStaleRes] = await Promise.all([
        scope(
          supabase.from("attendance" as any).select("id", { count: "exact", head: true }).eq("correction_status", "pending"),
        ),
        scope(
          supabase.from("overtime_requests" as any).select("id", { count: "exact", head: true }).eq("status", "pending"),
        ),
        scope(
          supabase.from("attendance_devices" as any).select("id", { count: "exact", head: true }).eq("status", "disabled"),
        ),
        // Devices that are active but haven't checked in for >24h.
        scope(
          supabase
            .from("attendance_devices" as any)
            .select("id", { count: "exact", head: true })
            .eq("status", "active")
            .or(`last_seen_at.is.null,last_seen_at.lt.${oneDayAgoIso}`),
        ),
      ]);

      const corrections = corrRes.count ?? 0;
      const overtime = otRes.count ?? 0;
      const devicesDisabled = devRes.count ?? 0;
      const devicesStale = devStaleRes.count ?? 0;
      return {
        corrections,
        overtime,
        devicesDisabled,
        devicesStale,
        total: corrections + overtime + devicesDisabled + devicesStale,
      };
    },
  });

  // Realtime push: when a correction or overtime request status changes in
  // the current org/business, invalidate the badge query so the sub-nav
  // reflects the new pending count within ~1s without waiting for the
  // 60s polling interval. Opt-out via VITE_DISABLE_REALTIME for tests.
  useEffect(() => {
    if (!currentOrg?.id) return;
    if (import.meta.env.VITE_DISABLE_REALTIME === "true") return;

    const filter = `organization_id=eq.${currentOrg.id}`;
    const topic = `attendance-inbox-${currentOrg.id}-${currentBusiness?.id ?? "all"}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(topic)
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "attendance_corrections", filter },
        () => qc.invalidateQueries({ queryKey }),
      )
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "overtime_requests", filter },
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
