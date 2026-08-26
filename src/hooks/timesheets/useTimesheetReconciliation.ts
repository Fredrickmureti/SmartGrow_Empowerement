/**
 * useTimesheetReconciliation — Wave 7 boundary check.
 *
 * Attendance owns PRESENCE (clock in / clock out). Timesheets own WORKED,
 * ATTRIBUTED time. They are deliberately different facts, so this hook never
 * merges them: it reads the server-side comparison view
 * v_timesheet_attendance_reconciliation and surfaces the variance so a human
 * can act on it. No hours arithmetic happens in the browser.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface TimesheetReconciliationRow {
  employee_id: string;
  day: string;
  attended_hours: number;
  recorded_hours: number;
  approved_hours: number;
  variance_hours: number;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export function useTimesheetReconciliation(from: string, to: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const query = useQuery<TimesheetReconciliationRow[]>({
    queryKey: [
      "timesheet-reconciliation",
      currentOrg?.id,
      currentBusiness?.id ?? null,
      from,
      to,
    ],
    enabled: !!currentOrg?.id && !!from && !!to,
    queryFn: async () => {
      // The view is newer than the generated types snapshot, so the table name
      // is not in the union yet; the row shape is pinned by .returns<T>() below.
      let q = (supabase.from as unknown as (t: string) => ReturnType<typeof supabase.from>)(
        "v_timesheet_attendance_reconciliation",
      )
        .select("employee_id, day, attended_hours, recorded_hours, approved_hours, variance_hours")
        .eq("organization_id", currentOrg!.id)
        .gte("day", from)
        .lte("day", to)
        .order("day", { ascending: false })
        .limit(1000);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);

      const { data, error } = await q.returns<TimesheetReconciliationRow[]>();
      if (error) throw error;
      return (data ?? []).map((r) => ({
        employee_id: r.employee_id,
        day: r.day,
        attended_hours: num(r.attended_hours),
        recorded_hours: num(r.recorded_hours),
        approved_hours: num(r.approved_hours),
        variance_hours: num(r.variance_hours),
      }));
    },
  });

  return {
    rows: query.data ?? [],
    /** Days where recorded time and presence disagree by more than 15 minutes. */
    mismatches: (query.data ?? []).filter((r) => Math.abs(r.variance_hours) > 0.25),
    isLoading: query.isLoading,
    error: query.error ?? null,
    refresh: query.refetch,
  };
}
