/**
 * MyAttendanceSummaryTile — month roll-up for /me/attendance.
 *
 * Surfaces the two things employees most want to see at a glance:
 *   • how many days in the current month need their attention
 *     (anomaly counts derived client-side from the records they own)
 *   • the standard hours per day they're expected to work, when we
 *     can derive it from their assigned work schedule
 *
 * No new RPCs — everything is read from hooks already on the page.
 */
import { useMemo } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { AlertTriangle, Calendar, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMyAttendance } from "@/hooks/hr/useMyAttendance";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { detectAnomalies } from "@/lib/attendance/anomalies";

interface Props {
  /** Optional: standard hours expected per day, from the employee's schedule. */
  standardHoursPerDay?: number | null;
  /** Optional name of the employee's work-schedule, e.g. "Weekday 9–5". */
  scheduleName?: string | null;
  /** Callback so the parent can scroll/jump to the calendar month. */
  onSeeFlagged?: () => void;
}

export function MyAttendanceSummaryTile({
  standardHoursPerDay,
  scheduleName,
  onSeeFlagged,
}: Props) {
  const today = new Date();
  const from = format(startOfMonth(today), "yyyy-MM-dd");
  const to = format(endOfMonth(today), "yyyy-MM-dd");
  const { records } = useMyAttendance({ from, to });
  const { settings } = useAttendanceSettings();

  const flagged = useMemo(() => {
    let count = 0;
    for (const r of records) {
      if (detectAnomalies(r, settings).length > 0) count += 1;
    }
    return count;
  }, [records, settings]);

  return (
    <Card>
      <CardContent className="p-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-3">
          {flagged > 0 ? (
            <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-500 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {flagged === 0
                ? "No days need your attention this month"
                : `${flagged} ${flagged === 1 ? "day" : "days"} need your attention`}
            </p>
            <p className="text-xs text-muted-foreground">
              {flagged === 0
                ? "Your attendance is clean for the current month."
                : "Missing checkout, late, or unverified device — fix before payroll closes."}
            </p>
            {flagged > 0 && onSeeFlagged && (
              <Button
                size="sm"
                variant="link"
                className="px-0 h-7 text-xs"
                onClick={onSeeFlagged}
              >
                See the flagged days →
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-start gap-3 sm:border-l sm:pl-4">
          <Calendar className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {standardHoursPerDay
                ? `${standardHoursPerDay}h scheduled per working day`
                : "No work schedule assigned"}
            </p>
            <p className="text-xs text-muted-foreground">
              {scheduleName
                ? scheduleName
                : standardHoursPerDay
                  ? "Standard target — exact start/end depend on your assigned shift."
                  : "Ask HR to assign your schedule so we can flag late arrivals."}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
