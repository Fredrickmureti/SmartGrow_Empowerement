/**
 * EmployeeTimesheetSummary — current/previous week rollup on Employee Profile.
 * Full entry/edit/approval workflow lives in the Timesheets app.
 */
import { Link } from "react-router-dom";
import { ArrowRight, Loader2, Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEmployeeTimesheetSummary } from "@/hooks/hr/useEmployeeTimesheetSummary";

export function EmployeeTimesheetSummary({ employeeId }: { employeeId: string }) {
  const { summary, isLoading } = useEmployeeTimesheetSummary(employeeId);

  if (isLoading) {
    return (
      <Card><CardContent className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </CardContent></Card>
    );
  }

  const billablePct = summary.thisWeekHours
    ? Math.round((summary.thisWeekBillable / summary.thisWeekHours) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="This week" value={`${summary.thisWeekHours}h`} hint="of 40h target" />
        <Stat label="Billable" value={`${summary.thisWeekBillable}h`} hint={`${billablePct}%`} />
        <Stat label="Last week" value={`${summary.lastWeekHours}h`} />
        <Stat label="Pending" value={String(summary.pendingSubmissions)} hint="awaiting approval" />
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Timer className="h-4 w-4" /> Top projects this week
          </CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/timesheets?employeeId=${employeeId}`}>
              Open Timesheets <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {summary.topProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No time logged this week.</p>
          ) : (
            <ul className="space-y-2">
              {summary.topProjects.map((p) => (
                <li key={p.name} className="flex items-center justify-between">
                  <span className="text-sm truncate pr-2">{p.name}</span>
                  <Badge variant="secondary">{p.hours}h</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold mt-1">{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </CardContent>
    </Card>
  );
}
