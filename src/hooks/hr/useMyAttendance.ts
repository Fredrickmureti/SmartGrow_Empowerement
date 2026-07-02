/**
 * useMyAttendance — server-side own-rows attendance for /me/attendance.
 *
 * RLS already restricts non-admin users to their own attendance rows, but
 * we still query with an explicit employee_id filter so the cache key is
 * partitioned per employee and we never depend on policy quirks for privacy.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import type { AttendanceRecord } from "@/hooks/useAttendance";

export function useMyAttendance(range?: { from: string; to: string }) {
  const { currentOrg } = useOrganization();
  const { currentEmployee } = useCurrentEmployee();

  const today = new Date().toISOString().split("T")[0];
  const from = range?.from ?? today;
  const to = range?.to ?? today;

  const { data: records = [], isLoading } = useQuery<AttendanceRecord[]>({
    queryKey: ["my-attendance", currentOrg?.id, currentEmployee?.id, from, to],
    queryFn: async () => {
      if (!currentOrg?.id || !currentEmployee?.id) return [];
      const { data, error } = await supabase
        .from("attendance")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", currentEmployee.id)
        .gte("attendance_date", from)
        .lte("attendance_date", to)
        .order("attendance_date", { ascending: false })
        .order("clock_in", { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as AttendanceRecord[];
    },
    enabled: !!currentOrg?.id && !!currentEmployee?.id,
  });

  return { records, isLoading };
}
