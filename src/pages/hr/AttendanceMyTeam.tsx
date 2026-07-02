/**
 * AttendanceMyTeam — manager-scoped command center.
 *
 * Renders the same primitives as Today but filtered to the current
 * employee's direct reports. The route is hidden in the sub-nav when
 * the user has no direct reports.
 *
 * No new queries: reuses useAttendance + useCurrentEmployee + the
 * AttendanceKpiStrip / AnomalyBadge primitives so the data is always
 * in sync with the Today page.
 */
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Link, Navigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Inbox, ArrowRight, Users } from "lucide-react";
import { useAttendance } from "@/hooks/useAttendance";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useBusinesses } from "@/hooks/useBusinesses";
import { todayInBusinessTz } from "@/lib/businessTime";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";

import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";
import { AttendanceKpiStrip } from "@/components/attendance/AttendanceKpiStrip";
import { AnomalyBadge } from "@/components/attendance/AnomalyBadge";
import { detectAnomalies } from "@/lib/attendance/anomalies";
import {
  EmployeeDayDrawer,
  type DayDrawerTarget,
} from "@/components/attendance/EmployeeDayDrawer";

export default function AttendanceMyTeam() {
  const { currentBusiness } = useBusinesses();
  const today = new Date();
  // Resolve "today" in the business timezone so manager-scoped roster
  // aligns with how attendance_date is stamped server-side.
  const dateStr = todayInBusinessTz(currentBusiness?.timezone);
  const { records, isLoading, openSessions } = useAttendance({ from: dateStr, to: dateStr });
  const { directReports, isManager, isLoading: empLoading } = useCurrentEmployee();
  const { settings } = useAttendanceSettings();
  const { counts } = useAttendanceInboxCounts();
  const [drawerTarget, setDrawerTarget] = useState<DayDrawerTarget | null>(null);

  const directReportIds = useMemo(
    () => new Set(directReports.map((r) => r.id)),
    [directReports],
  );

  const teamRecords = useMemo(
    () => records.filter((r) => directReportIds.has(r.employee_id)),
    [records, directReportIds],
  );

  // Synthesize KPI inputs scoped to the team only. "Checked in now" must
  // count OPEN sessions (Odoo-aligned) — independent of attendance_date so
  // overnight shifts remain visible past midnight.
  const teamOpenSessionCount = useMemo(
    () => (openSessions as any[]).filter((s) => directReportIds.has(s.employee_id)).length,
    [openSessions, directReportIds],
  );
  const kpis = useMemo(() => {
    let present = 0, late = 0, absent = 0;
    for (const r of teamRecords) {
      if (r.status === "present") present++;
      else if (r.status === "late") late++;
      else if (r.status === "absent") absent++;
    }
    return { present, late, absent, checkedInNow: teamOpenSessionCount };
  }, [teamRecords, teamOpenSessionCount]);


  const annotated = useMemo(
    () =>
      teamRecords.map((r) => ({
        record: r,
        anomalies: detectAnomalies(r, settings),
      })),
    [teamRecords, settings],
  );

  if (!empLoading && !isManager) {
    return <Navigate to="/hr/attendance" replace />;
  }

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Users className="h-5 w-5" />
            My team
          </h1>
          <p className="text-sm text-muted-foreground">
            {format(today, "MMM d, yyyy")} · {directReports.length} direct
            report{directReports.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="action-buttons flex flex-wrap gap-2">
          {counts.total > 0 && (
            <Button asChild variant="outline" className="gap-2">
              <Link to="/hr/attendance/approvals">
                <Inbox className="h-4 w-4" />
                Approvals
                <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                  {counts.total}
                </Badge>
              </Link>
            </Button>
          )}
        </div>
      </div>

      <AttendanceKpiStrip
        checkedInNow={kpis.checkedInNow}
        totalEmployees={directReports.length}
        present={kpis.present}
        late={kpis.late}
        absent={kpis.absent}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Team roster</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : annotated.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              No attendance records for your team today yet.
              <div className="mt-2">
                <Link
                  to="/hr/attendance"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View full roster <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Clock in</TableHead>
                  <TableHead>Clock out</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {annotated.map(({ record: r, anomalies }) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() =>
                      setDrawerTarget({
                        record: r,
                        employeeName: r.employee
                          ? `${r.employee.first_name} ${r.employee.last_name}`
                          : "Unknown",
                        employeeNumber: r.employee?.employee_number,
                        branchName: null,
                      })
                    }
                  >
                    <TableCell className="font-medium">
                      {r.employee
                        ? `${r.employee.first_name} ${r.employee.last_name}`
                        : "Unknown"}
                    </TableCell>
                    <TableCell>
                      {r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—"}
                    </TableCell>
                    <TableCell>
                      {r.clock_out ? format(new Date(r.clock_out), "hh:mm a") : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {(r.worked_hours ?? 0).toFixed(1)}
                    </TableCell>
                    <TableCell className="capitalize">
                      {r.status.replace("_", " ")}
                    </TableCell>
                    <TableCell>
                      <AnomalyBadge anomalies={anomalies} compact />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {drawerTarget && (
        <EmployeeDayDrawer
          target={drawerTarget}
          open={!!drawerTarget}
          onOpenChange={(open) => !open && setDrawerTarget(null)}
        />
      )}
    </div>
  );
}