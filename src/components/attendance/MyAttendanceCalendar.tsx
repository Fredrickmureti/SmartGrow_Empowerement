/**
 * MyAttendanceCalendar — month-grid view of an employee's own attendance.
 *
 * Each day cell shows a status dot (present/late/absent/leave/holiday)
 * plus worked hours. Clicking a day opens the EmployeeDayDrawer in
 * self-service mode so the employee can review the timeline and
 * request a correction.
 */
import { useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AttendanceRecord } from "@/hooks/useAttendance";
import { useMyAttendance } from "@/hooks/hr/useMyAttendance";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { detectAnomalies } from "@/lib/attendance/anomalies";
import {
  EmployeeDayDrawer,
  type DayDrawerTarget,
} from "./EmployeeDayDrawer";

const STATUS_DOT: Record<string, string> = {
  present: "bg-emerald-500",
  late: "bg-amber-500",
  absent: "bg-rose-500",
  half_day: "bg-blue-500",
  on_leave: "bg-purple-500",
  holiday: "bg-gray-400",
};

export function MyAttendanceCalendar({
  employeeName,
  onRequestCorrection,
  onRequestBlankCorrection,
}: {
  employeeName: string;
  onRequestCorrection?: (record: AttendanceRecord) => void;
  /** Invoked when the employee opens a past working day that has no record at all. */
  onRequestBlankCorrection?: (date: string) => void;
}) {
  const [cursor, setCursor] = useState(() => new Date());
  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const { records, isLoading } = useMyAttendance({
    from: format(gridStart, "yyyy-MM-dd"),
    to: format(gridEnd, "yyyy-MM-dd"),
  });
  const { settings } = useAttendanceSettings();

  const byDate = useMemo(() => {
    const m = new Map<string, AttendanceRecord>();
    for (const r of records) m.set(r.attendance_date, r);
    return m;
  }, [records]);

  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const [target, setTarget] = useState<DayDrawerTarget | null>(null);
  const todayStr = format(new Date(), "yyyy-MM-dd");

  const openDay = (d: Date) => {
    const key = format(d, "yyyy-MM-dd");
    const record = byDate.get(key);
    if (record) {
      setTarget({
        record,
        employeeName,
        selfServiceMode: true,
        onRequestCorrection: () => {
          setTarget(null);
          onRequestCorrection?.(record);
        },
      });
      return;
    }
    // No record on a past day — let employee request a correction directly.
    if (key < todayStr && onRequestBlankCorrection) {
      onRequestBlankCorrection(key);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">{format(cursor, "MMMM yyyy")}</CardTitle>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setCursor((d) => subMonths(d, 1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCursor(new Date())}>
              Today
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setCursor((d) => addMonths(d, 1))}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-1 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="text-center py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((d) => {
              const key = format(d, "yyyy-MM-dd");
              const record = byDate.get(key);
              const inMonth = isSameMonth(d, cursor);
              const status = record?.status;
              const hours = record?.worked_hours ?? 0;
              const anomalies = record ? detectAnomalies(record, settings) : [];
              const isPastWorkday = key < todayStr;
              const canRequestBlank = !record && isPastWorkday && !!onRequestBlankCorrection;
              const interactive = !!record || canRequestBlank;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => openDay(d)}
                  disabled={!interactive}
                  className={cn(
                    "aspect-square rounded-md border p-1.5 text-left flex flex-col justify-between transition-colors relative",
                    inMonth ? "bg-card" : "bg-muted/20 text-muted-foreground",
                    interactive && "hover:border-primary cursor-pointer",
                    !interactive && "cursor-default opacity-60",
                    isToday(d) && "ring-1 ring-primary",
                    anomalies.length > 0 && "border-amber-400/60",
                    canRequestBlank && inMonth && "border-dashed",
                  )}
                  title={
                    anomalies.length > 0
                      ? `Needs attention: ${anomalies.map((a) => a.label).join(", ")}`
                      : canRequestBlank
                        ? "No record — click to request a correction"
                        : undefined
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{format(d, "d")}</span>
                    {status && (
                      <span
                        className={cn("h-2 w-2 rounded-full", STATUS_DOT[status] ?? "bg-muted-foreground")}
                        title={status.replace("_", " ")}
                      />
                    )}
                  </div>
                  {record && hours > 0 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {hours.toFixed(1)}h
                    </span>
                  )}
                  {canRequestBlank && (
                    <span className="text-[10px] text-muted-foreground italic">
                      no record
                    </span>
                  )}
                  {anomalies.length > 0 && (
                    <span className="absolute bottom-0.5 right-0.5 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <Legend dot="bg-emerald-500" label="Present" />
            <Legend dot="bg-amber-500" label="Late" />
            <Legend dot="bg-rose-500" label="Absent" />
            <Legend dot="bg-purple-500" label="On leave" />
            <Legend dot="bg-gray-400" label="Holiday" />
            {isLoading && <span className="italic">loading…</span>}
          </div>
        </CardContent>
      </Card>

      <EmployeeDayDrawer
        target={target}
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
      />
    </>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", dot)} />
      {label}
    </span>
  );
}
