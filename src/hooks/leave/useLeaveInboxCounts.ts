/**
 * useLeaveInboxCounts — single source of truth for Time-off "work waiting".
 *
 * Returns counts of leave_requests awaiting first-level approval and those
 * waiting on a second-level approver. Mirrors useAttendanceInboxCounts.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface LeaveInboxCounts {
  pending: number;
  pendingSecondLevel: number;
  total: number;
}

const ZERO: LeaveInboxCounts = { pending: 0, pendingSecondLevel: 0, total: 0 };

export function useLeaveInboxCounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const queryKey = ["leave-inbox-counts", currentOrg?.id, currentBusiness?.id];

  const { data = ZERO, isLoading } = useQuery<LeaveInboxCounts>({
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

      const [pendingRes, l2Res] = await Promise.all([
        scope(
          supabase.from("leave_requests" as any).select("id", { count: "exact", head: true }).eq("status", "pending"),
        ),
        scope(
          supabase.from("leave_requests" as any).select("id", { count: "exact", head: true }).eq("status", "pending_second_approval"),
        ),
      ]);

      const pending = pendingRes.count ?? 0;
      const pendingSecondLevel = l2Res.count ?? 0;
      return { pending, pendingSecondLevel, total: pending + pendingSecondLevel };
    },
  });

  useEffect(() => {
    if (!currentOrg?.id) return;
    if (import.meta.env.VITE_DISABLE_REALTIME === "true") return;
    const filter = `organization_id=eq.${currentOrg.id}`;
    const topic = `leave-inbox-${currentOrg.id}-${currentBusiness?.id ?? "all"}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(topic)
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "leave_requests", filter },
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
