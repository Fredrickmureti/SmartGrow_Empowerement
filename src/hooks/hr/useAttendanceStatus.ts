/**
 * useAttendanceStatus — real-time check-in state for the current employee.
 *
 * Returns whether the employee is currently checked in, the active session,
 * and today's total worked hours across all sessions.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useBusinesses } from "@/hooks/useBusinesses";
import { todayInBusinessTz } from "@/lib/businessTime";

export interface AttendanceStatus {
  isCheckedIn: boolean;
  currentSession: {
    id: string;
    clock_in: string;
    attendance_date: string;
  } | null;
  currentBreak: {
    id: string;
    started_at: string;
    break_type: string;
  } | null;
  todaySessions: Array<{
    id: string;
    clock_in: string | null;
    clock_out: string | null;
    worked_hours: number | null;
    status: string;
  }>;
  todayTotalHours: number;
}

const EMPTY: AttendanceStatus = {
  isCheckedIn: false,
  currentSession: null,
  currentBreak: null,
  todaySessions: [],
  todayTotalHours: 0,
};

export function useAttendanceStatus() {
  const { currentOrg } = useOrganization();
  const { currentEmployee } = useCurrentEmployee();
  const { currentBusiness } = useBusinesses();

  const { data: status = EMPTY, isLoading, refetch } = useQuery({
    queryKey: ["attendance-status", currentOrg?.id, currentEmployee?.id, currentBusiness?.timezone],
    queryFn: async () => {
      if (!currentOrg?.id || !currentEmployee?.id) return EMPTY;

      // Today must be derived in the business timezone so overnight shifts
      // and tenants whose local day != UTC day still resolve correctly.
      const today = todayInBusinessTz(currentBusiness?.timezone);


      // Get open session (clock_out IS NULL)
      const { data: openSession } = await supabase
        .from("attendance")
        .select("id, clock_in, attendance_date")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", currentEmployee.id)
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Get today's sessions
      const { data: todaySessions } = await supabase
        .from("attendance")
        .select("id, clock_in, clock_out, worked_hours, status")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", currentEmployee.id)
        .eq("attendance_date", today)
        .order("clock_in", { ascending: true });

      // Get open break (only one allowed by unique partial index)
      let currentBreak: AttendanceStatus["currentBreak"] = null;
      if (openSession) {
        const { data: openBreak } = await supabase
          .from("attendance_breaks" as any)
          .select("id, started_at, break_type")
          .eq("attendance_id", openSession.id)
          .is("ended_at", null)
          .maybeSingle();
        if (openBreak) {
          currentBreak = openBreak as any;
        }
      }

      const sessions = todaySessions || [];
      const totalHours = sessions.reduce(
        (sum, s) => sum + (s.worked_hours || 0),
        0
      );

      return {
        isCheckedIn: !!openSession,
        currentSession: openSession
          ? {
              id: openSession.id,
              clock_in: openSession.clock_in!,
              attendance_date: openSession.attendance_date,
            }
          : null,
        currentBreak,
        todaySessions: sessions,
        todayTotalHours: Math.round(totalHours * 100) / 100,
      } as AttendanceStatus;
    },
    enabled: !!currentOrg?.id && !!currentEmployee?.id,
    refetchInterval: 60_000, // refresh every minute for live elapsed time
  });

  return { status, isLoading, refetch };
}

