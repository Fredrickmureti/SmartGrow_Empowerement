/**
 * TimesheetConsistencyCard
 *
 * Surfaces (read-only) employee/day pairs where total timesheet hours
 * exceed attendance worked_hours by more than the grace allowance.
 * Mirrors Odoo's "timesheet vs attendance" sanity widget. No auto-fix.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";

const GRACE_HOURS = 0.5;

interface Inconsistency {
  employee_id: string;
  employee_name: string;
  date: string;
  attendanceHours: number;
  timesheetHours: number;
}

export function TimesheetConsistencyCard({ from, to }: { from: string; to: string }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const { data, isLoading } = useQuery({
    queryKey: ["attendance-timesheet-consistency", currentOrg?.id, currentBusiness?.id, currentBranch?.id, from, to],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async (): Promise<Inconsistency[]> => {
      let attQ: any = supabase
        .from("attendance")
        .select("employee_id, attendance_date, worked_hours, employee:employees(first_name, last_name)")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .gte("attendance_date", from)
        .lte("attendance_date", to)
        .not("clock_out", "is", null);
      attQ = applyBranchFilter(attQ, currentBranch?.id);

      let tsQ: any = supabase
        .from("timesheets")
        .select("employee_id, date, hours")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .gte("date", from)
        .lte("date", to);
      tsQ = applyBranchFilter(tsQ, currentBranch?.id);

      const [{ data: att }, { data: ts }] = await Promise.all([attQ, tsQ]);

      const attMap = new Map<string, { hours: number; name: string }>();
      for (const r of att || []) {
        const k = `${r.employee_id}|${r.attendance_date}`;
        const e = (r as any).employee;
        const name = e ? `${e.first_name} ${e.last_name}` : "Unknown";
        const cur = attMap.get(k) ?? { hours: 0, name };
        cur.hours += Number(r.worked_hours ?? 0);
        attMap.set(k, cur);
      }
      const tsMap = new Map<string, number>();
      for (const r of ts || []) {
        const k = `${r.employee_id}|${r.date}`;
        tsMap.set(k, (tsMap.get(k) ?? 0) + Number(r.hours ?? 0));
      }
      const issues: Inconsistency[] = [];
      for (const [k, tHours] of tsMap.entries()) {
        const att = attMap.get(k);
        const aHours = att?.hours ?? 0;
        if (tHours > aHours + GRACE_HOURS) {
          const [employee_id, date] = k.split("|");
          issues.push({
            employee_id,
            employee_name: att?.name ?? "Unknown",
            date,
            attendanceHours: aHours,
            timesheetHours: tHours,
          });
        }
      }
      return issues
        .sort((a, b) => b.timesheetHours - b.attendanceHours - (a.timesheetHours - a.attendanceHours))
        .slice(0, 10);
    },
  });

  const issues = useMemo(() => data ?? [], [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Timesheet vs attendance consistency
        </CardTitle>
        {issues.length > 0 && <Badge variant="secondary">{issues.length} flagged</Badge>}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All employees logged timesheet hours within their attendance window.
          </p>
        ) : (
          <div className="space-y-1 text-sm">
            {issues.map((i) => (
              <div key={`${i.employee_id}-${i.date}`} className="flex items-center justify-between border-b py-1.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="font-medium truncate">{i.employee_name}</div>
                  <div className="text-xs text-muted-foreground">{i.date}</div>
                </div>
                <div className="text-right text-xs">
                  <div>
                    Timesheet <span className="font-semibold">{i.timesheetHours.toFixed(2)}h</span>
                  </div>
                  <div className="text-muted-foreground">
                    Attendance {i.attendanceHours.toFixed(2)}h
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
