/**
 * EmployeeAttendanceSummary — last-30-day rollup shown on Employee Profile.
 * Full workflow lives in the Attendance app.
 */
import { Link } from "react-router-dom";
import { useState } from "react";
import { ArrowRight, Clock, AlertCircle, CheckCircle, XCircle, Loader2, KeyRound } from "lucide-react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEmployeeAttendanceSummary } from "@/hooks/hr/useEmployeeAttendanceSummary";
import { usePermissions } from "@/hooks/usePermissions";
import { SetKioskPinDialog } from "./SetKioskPinDialog";

export function EmployeeAttendanceSummary({ employeeId }: { employeeId: string }) {
  const { summary, isLoading } = useEmployeeAttendanceSummary(employeeId, 30);
  const { can } = usePermissions();
  const [pinOpen, setPinOpen] = useState(false);

  if (isLoading) {
    return (
      <Card><CardContent className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </CardContent></Card>
    );
  }

  const max = Math.max(1, ...summary.byDay.map((d) => d.hours));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={CheckCircle} label="Present" value={String(summary.presentDays)} accent="text-emerald-600" />
        <Stat icon={AlertCircle} label="Late" value={String(summary.lateDays)} accent="text-amber-600" />
        <Stat icon={XCircle} label="Absent" value={String(summary.absentDays)} accent="text-rose-600" />
        <Stat icon={Clock} label="Avg / day" value={`${summary.avgHoursPerDay}h`} />
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Last 30 days</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Total {summary.totalHours}h</span>
            {can("manageEmployees") && (
              <Button variant="outline" size="sm" onClick={() => setPinOpen(true)}>
                <KeyRound className="h-3.5 w-3.5 mr-1" /> Set Kiosk PIN
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {summary.byDay.length === 0 ? (
            <p className="text-sm text-muted-foreground">No attendance recorded.</p>
          ) : (
            <div className="flex items-end gap-1 h-24">
              {summary.byDay.map((d) => (
                <div
                  key={d.date}
                  className="flex-1 bg-primary/70 rounded-t hover:bg-primary transition-colors"
                  style={{ height: `${(d.hours / max) * 100}%`, minHeight: 2 }}
                  title={`${format(new Date(d.date), "MMM d")} · ${d.hours}h`}
                />
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {summary.lastCheckIn
                ? `Last check-in: ${format(new Date(summary.lastCheckIn), "MMM d, HH:mm")}`
                : "No recent check-in"}
            </span>
            <Button asChild variant="ghost" size="sm">
              <Link to={`/hr/attendance?employeeId=${employeeId}`}>
                Open Attendance <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
      <SetKioskPinDialog
        employeeId={employeeId}
        open={pinOpen}
        onOpenChange={setPinOpen}
      />
    </div>
  );
}

function Stat({
  icon: Icon, label, value, accent,
}: { icon: any; label: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className={`h-3.5 w-3.5 ${accent || ""}`} />
          {label}
        </div>
        <div className="text-xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}
