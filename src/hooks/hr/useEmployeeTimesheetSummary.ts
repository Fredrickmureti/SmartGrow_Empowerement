/**
 * useEmployeeTimesheetSummary
 *
 * Read-only summary of an employee's timesheet activity for the current
 * and previous week. Used inside Employee Profile → Timesheets.
 */
import { useEffect, useState } from "react";
import { startOfWeek, endOfWeek, subWeeks, format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { getWeekStart } from "@/lib/datetime/weekStart";

export interface TimesheetSummary {
  thisWeekHours: number;
  thisWeekBillable: number;
  lastWeekHours: number;
  pendingSubmissions: number;
  topProjects: { name: string; hours: number }[];
  weekStart: string;
  weekEnd: string;
}

const EMPTY: TimesheetSummary = {
  thisWeekHours: 0, thisWeekBillable: 0, lastWeekHours: 0,
  pendingSubmissions: 0, topProjects: [],
  weekStart: "", weekEnd: "",
};

export function useEmployeeTimesheetSummary(employeeId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [summary, setSummary] = useState<TimesheetSummary>(EMPTY);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!employeeId || !currentOrg) return;
    let cancelled = false;
    setIsLoading(true);

    const today = new Date();
    const ws = getWeekStart(currentBusiness);
    const wkStart = startOfWeek(today, { weekStartsOn: ws });
    const wkEnd = endOfWeek(today, { weekStartsOn: ws });
    const lastStart = startOfWeek(subWeeks(today, 1), { weekStartsOn: ws });
    const lastEnd = endOfWeek(subWeeks(today, 1), { weekStartsOn: ws });

    const fmt = (d: Date) => format(d, "yyyy-MM-dd");

    Promise.all([
      supabase
        .from("timesheets")
        .select("date, hours, is_billable, project:projects(name)")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", employeeId)
        .gte("date", fmt(lastStart))
        .lte("date", fmt(wkEnd)),
      supabase
        .from("timesheet_submissions")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", employeeId)
        .eq("status", "submitted"),
    ]).then(([tsRes, subRes]) => {
      if (cancelled) return;
      const rows = (tsRes.data as any[]) || [];
      const ws = fmt(wkStart), we = fmt(wkEnd);
      const ls = fmt(lastStart), le = fmt(lastEnd);

      let thisH = 0, thisB = 0, lastH = 0;
      const projMap = new Map<string, number>();
      for (const r of rows) {
        const h = Number(r.hours || 0);
        if (r.date >= ws && r.date <= we) {
          thisH += h;
          if (r.is_billable) thisB += h;
          const pn = r.project?.name || "Unassigned";
          projMap.set(pn, (projMap.get(pn) || 0) + h);
        } else if (r.date >= ls && r.date <= le) {
          lastH += h;
        }
      }
      const top = Array.from(projMap, ([name, hours]) => ({ name, hours }))
        .sort((a, b) => b.hours - a.hours).slice(0, 3);

      setSummary({
        thisWeekHours: Math.round(thisH * 100) / 100,
        thisWeekBillable: Math.round(thisB * 100) / 100,
        lastWeekHours: Math.round(lastH * 100) / 100,
        pendingSubmissions: subRes.data?.length || 0,
        topProjects: top,
        weekStart: ws, weekEnd: we,
      });
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [employeeId, currentOrg?.id, currentBusiness?.week_starts_on]);

  return { summary, isLoading };
}
