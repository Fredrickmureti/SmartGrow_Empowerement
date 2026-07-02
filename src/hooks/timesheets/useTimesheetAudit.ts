/**
 * useTimesheetAudit — reads the timesheet_audit_log for an employee + date
 * range. Backed by the audit table created in the timesheets overhaul
 * migration. Read-only; RLS scopes by org.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface TimesheetAuditRow {
  id: string;
  timesheet_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  actor_user_id: string | null;
  reason: string | null;
  metadata: any;
  created_at: string;
}

export function useTimesheetAudit(
  employeeId: string | null | undefined,
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
) {
  const [rows, setRows] = useState<TimesheetAuditRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!employeeId || !periodStart || !periodEnd) { setRows([]); return; }
    setIsLoading(true);
    // Two-step: pull timesheet ids in window, then audit rows for those ids.
    const { data: tids } = await (supabase as any)
      .from("timesheets")
      .select("id")
      .eq("employee_id", employeeId)
      .gte("date", periodStart)
      .lte("date", periodEnd);
    const ids = (tids || []).map((r: any) => r.id);
    if (ids.length === 0) { setRows([]); setIsLoading(false); return; }
    const { data, error } = await (supabase as any)
      .from("timesheet_audit_log")
      .select("*")
      .in("timesheet_id", ids)
      .order("created_at", { ascending: false });
    if (!error) setRows((data || []) as TimesheetAuditRow[]);
    setIsLoading(false);
  }, [employeeId, periodStart, periodEnd]);

  useEffect(() => { fetch(); }, [fetch]);

  return { rows, isLoading, refresh: fetch };
}
