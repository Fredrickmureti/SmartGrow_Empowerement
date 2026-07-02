/**
 * useOvertimeRequests — HR queue for overtime pre-approval workflow.
 *
 * Reads `overtime_requests` scoped by org/business; decisions go through
 * SECURITY DEFINER RPC `overtime_request_decide`.
 */
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { dispatchApprovalNotification } from "@/lib/hr/approvalNotifications";

export interface OvertimeRequest {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  employee_id: string;
  ot_date: string;
  requested_hours: number;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string | null;
  } | null;
}

export function useOvertimeRequests(filterStatus?: "pending" | "approved" | "rejected" | "cancelled" | "all") {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const status = filterStatus ?? "pending";

  const { data: requests = [], isLoading } = useQuery<OvertimeRequest[]>({
    queryKey: ["overtime-requests", currentOrg?.id, currentBusiness?.id, status],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("overtime_requests" as any)
        .select("*, employee:employees(id, first_name, last_name, employee_number)")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as OvertimeRequest[];
    },
    enabled: !!currentOrg?.id,
  });

  // Realtime: managers viewing the OT queue see new submissions and decisions
  // appear within ~1s without polling. Mirrors useAttendanceInboxCounts.
  useEffect(() => {
    if (!currentOrg?.id) return;
    if (import.meta.env.VITE_DISABLE_REALTIME === "true") return;
    const filter = `organization_id=eq.${currentOrg.id}`;
    const topic = `overtime-requests-${currentOrg.id}-${currentBusiness?.id ?? "all"}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(topic)
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "overtime_requests", filter },
        () => qc.invalidateQueries({ queryKey: ["overtime-requests"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id, currentBusiness?.id]);

  const decide = useMutation({
    mutationFn: async (input: {
      id: string;
      decision: "approved" | "rejected";
      reason?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("overtime_request_decide" as any, {
        _id: input.id,
        _decision: input.decision,
        _reason: input.reason ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async (_d, vars) => {
      toast.success(vars.decision === "approved" ? "Overtime approved" : "Overtime rejected");
      qc.invalidateQueries({ queryKey: ["overtime-requests"] });
      if (currentOrg?.id) {
        const { data: { user } } = await supabase.auth.getUser();
        void dispatchApprovalNotification({
          organizationId: currentOrg.id,
          entityType: "overtime_request",
          entityId: vars.id,
          event: vars.decision,
          actorUserId: user?.id ?? null,
        });
      }
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to update overtime request"),
  });

  return {
    requests,
    isLoading,
    decide: decide.mutate,
    isDeciding: decide.isPending,
  };
}
