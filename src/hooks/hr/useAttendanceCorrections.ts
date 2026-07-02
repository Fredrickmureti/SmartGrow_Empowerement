/**
 * useAttendanceCorrections — admin/manager queue.
 *
 * Reads from `attendance_corrections` (audit-grade history) and exposes
 * approve/reject mutations that delegate to the existing useAttendance
 * RPC bindings.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { applyBranchFilter } from "@/lib/branchScope";

export interface AttendanceCorrection {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  attendance_id: string | null;
  employee_id: string;
  attendance_date: string;
  proposed_clock_in: string | null;
  proposed_clock_out: string | null;
  proposed_status: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_by: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
  };
}

export function useAttendanceCorrections(status?: "pending" | "approved" | "rejected") {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const { data: corrections = [], isLoading } = useQuery<AttendanceCorrection[]>({
    queryKey: [
      "attendance-corrections",
      currentOrg?.id,
      currentBusiness?.id,
      currentBranch?.id,
      status ?? "all",
    ],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("attendance_corrections")
        .select(
          "*, employee:employees(id, first_name, last_name, employee_number)"
        )
        .eq("organization_id", currentOrg.id)
        .order("requested_at", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (status) q = q.eq("status", status);
      q = applyBranchFilter(q, currentBranch?.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as AttendanceCorrection[];
    },
    enabled: !!currentOrg?.id,
  });

  const pending = corrections.filter((c) => c.status === "pending");
  const reviewed = corrections.filter((c) => c.status !== "pending");

  return { corrections, pending, reviewed, isLoading };
}
