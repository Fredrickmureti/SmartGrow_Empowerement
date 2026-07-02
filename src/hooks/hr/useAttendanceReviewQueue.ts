/**
 * useAttendanceReviewQueue — surfaces attendance rows that the clock-in
 * RPC flagged with `requires_review = true` (impossible travel, untrusted
 * device, geofence fail, etc.). These rows are otherwise invisible until
 * an HR manager browses to that employee's day drawer, which means the
 * whole risk-engine output is silently ignored.
 *
 * Read-only hook — clearing a row goes through the `attendance_anomaly_ack`
 * RPC (mutation lives in useAttendanceActions).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { applyBranchFilter } from "@/lib/branchScope";

export interface ReviewQueueRow {
  id: string;
  attendance_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: string;
  review_reasons: string[];
  employee_id: string;
  branch_id: string | null;
  employee: {
    first_name: string;
    last_name: string;
    employee_number: string | null;
  } | null;
}

export function useAttendanceReviewQueue() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  return useQuery({
    queryKey: [
      "attendance-review-queue",
      currentOrg?.id,
      currentBusiness?.id,
      currentBranch?.id,
    ],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ReviewQueueRow[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      let q = supabase
        .from("attendance" as any)
        .select(
          "id, attendance_date, clock_in, clock_out, status, review_reasons, employee_id, branch_id, employee:employees(first_name, last_name, employee_number)",
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("requires_review", true)
        .eq("is_locked", false)
        .order("clock_in", { ascending: false })
        .limit(100);
      q = applyBranchFilter(q, currentBranch?.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ReviewQueueRow[];
    },
  });
}
