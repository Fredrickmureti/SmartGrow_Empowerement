/**
 * useEmployeeAttendanceSummary
 *
 * Read-only summary of an employee's attendance over a rolling window.
 * Used inside the Employee Profile → Attendance section. Full workflow
 * lives in the Attendance app.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export interface AttendanceSummary {
  totalDays: number;
  presentDays: number;
  lateDays: number;
  absentDays: number;
  totalHours: number;
  avgHoursPerDay: number;
  lastCheckIn: string | null;
  byDay: { date: string; hours: number }[];
}

const EMPTY: AttendanceSummary = {
  totalDays: 0, presentDays: 0, lateDays: 0, absentDays: 0,
  totalHours: 0, avgHoursPerDay: 0, lastCheckIn: null, byDay: [],
};

export function useEmployeeAttendanceSummary(employeeId: string | undefined, days = 30) {
  const { currentOrg } = useOrganization();
  const [summary, setSummary] = useState<AttendanceSummary>(EMPTY);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!employeeId || !currentOrg) return;
    let cancelled = false;
    setIsLoading(true);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    supabase
      .from("attendance")
      .select("attendance_date, clock_in, clock_out, worked_hours, status")
      .eq("organization_id", currentOrg.id)
      .eq("employee_id", employeeId)
      .gte("attendance_date", sinceStr)
      .order("attendance_date", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setSummary(EMPTY);
          setIsLoading(false);
          return;
        }
        const byDayMap = new Map<string, number>();
        let totalHours = 0;
        let present = 0, late = 0, absent = 0;
        let lastCheckIn: string | null = null;

        for (const r of data) {
          const h = Number(r.worked_hours || 0);
          totalHours += h;
          byDayMap.set(r.attendance_date, (byDayMap.get(r.attendance_date) || 0) + h);
          const s = (r.status || "").toLowerCase();
          if (s === "present" || s === "checked_in" || s === "checked_out") present++;
          else if (s === "late") { present++; late++; }
          else if (s === "absent") absent++;
          if (!lastCheckIn && r.clock_in) lastCheckIn = r.clock_in;
        }
        const totalDays = byDayMap.size; // unique dates, not raw record count
        setSummary({
          totalDays, presentDays: present, lateDays: late, absentDays: absent,
          totalHours: Math.round(totalHours * 100) / 100,
          avgHoursPerDay: totalDays ? Math.round((totalHours / totalDays) * 100) / 100 : 0,
          lastCheckIn,
          byDay: Array.from(byDayMap, ([date, hours]) => ({ date, hours }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        });
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [employeeId, currentOrg?.id, days]);

  return { summary, isLoading };
}
