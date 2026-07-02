/**
 * MyDayProgressCard — single-glance "your day" frame for /me/attendance.
 *
 * Surfaces what an enterprise attendance user actually needs:
 *   • Scheduled shift window (start / end / target hours)
 *   • Hours worked today vs target — with progress bar
 *   • Live "elapsed in current session" tick
 *   • Break minutes used vs policy cap (if configured)
 *   • OT chip when worked > target
 *   • Subtle weekly totals strip below
 *
 * Pure derivation from hooks already in use; no new queries.
 */
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Coffee, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAttendanceStatus } from "@/hooks/hr/useAttendanceStatus";
import { useMyShiftToday } from "@/hooks/hr/useMyShiftToday";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";

interface Props {
  /** Weekly aggregates demoted to a small strip beneath the card. */
  weeklyHours: number;
  weeklyOvertime: number;
  weeklySessions: number;
}

function liveElapsed(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.floor(diff / 60000));
  return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function MyDayProgressCard({
  weeklyHours,
  weeklyOvertime,
  weeklySessions,
}: Props) {
  const { status } = useAttendanceStatus();
  const { scheduleName, standardHoursPerDay } = useMyShiftToday();
  const { settings } = useAttendanceSettings();

  // Re-tick once a minute so the elapsed counter stays live.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!status.currentSession) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [status.currentSession]);

  const target = standardHoursPerDay ?? 8;
  const worked = status.todayTotalHours ?? 0;
  const pct = Math.min(100, Math.round((worked / Math.max(target, 0.1)) * 100));
  const remaining = Math.max(0, target - worked);
  const overTarget = worked > target;

  const maxBreakMin = (settings as any)?.max_break_minutes ?? null;
  const breakUsed = 0; // attendance_breaks aggregate not yet exposed; placeholder for future wiring

  const pctTone = overTarget
    ? "bg-emerald-500"
    : pct >= 75
      ? "bg-emerald-500"
      : pct >= 25
        ? "bg-amber-500"
        : "bg-muted-foreground/40";

  return (
    <div className="space-y-2">
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Your day
              </div>
              <div className="mt-0.5 text-sm">
                {scheduleName ?? "No schedule assigned"}
                {standardHoursPerDay != null && (
                  <span className="text-muted-foreground"> · target {standardHoursPerDay}h</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {status.currentSession ? (
                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
                  Clocked in · {liveElapsed(status.currentSession.clock_in)}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">Not clocked in</Badge>
              )}
              {overTarget && (
                <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                  <TrendingUp className="h-3 w-3 mr-1" /> Over target
                </Badge>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <div className="tabular-nums">
                <span className="text-2xl font-semibold">{worked.toFixed(1)}h</span>
                <span className="text-muted-foreground"> / {target}h</span>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {overTarget
                  ? `+${(worked - target).toFixed(1)}h over`
                  : remaining > 0
                    ? `${remaining.toFixed(1)}h to go`
                    : "Target met"}
              </div>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all", pctTone)}
                style={{ width: `${pct}%` }}
                aria-label={`${pct}% of daily target`}
              />
            </div>
          </div>

          {maxBreakMin != null && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Coffee className="h-3.5 w-3.5" />
              Break used: {breakUsed}m of {maxBreakMin}m allowed
            </div>
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground px-1 tabular-nums">
        This week: <span className="text-foreground font-medium">{weeklyHours.toFixed(1)}h</span>
        {" · "}OT <span className="text-foreground font-medium">{weeklyOvertime.toFixed(1)}h</span>
        {" · "}<span className="text-foreground font-medium">{weeklySessions}</span> session{weeklySessions === 1 ? "" : "s"}
      </div>
    </div>
  );
}
