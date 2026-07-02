/**
 * MyWeekStrip — week-at-a-glance schedule strip for /me/attendance.
 *
 * Renders 7 chips Mon–Sun for an ISO week (navigable ←/→). Each chip
 * surfaces:
 *   • The scheduled shift window (start–end) from the employee's
 *     work_schedule_days.
 *   • A "Leave" badge when the day is inside an approved leave_request.
 *   • A "Holiday" badge when the day matches a row in public_holidays.
 *
 * Today is highlighted. Click a chip to open the same correction flow the
 * monthly calendar uses (blank-day handling included).
 *
 * Reuses already-loaded queries; only adds one work_schedule_days fetch
 * keyed on the employee's work_schedule_id.
 */
import { useMemo, useState } from "react";
import {
  addDays,
  addWeeks,
  format,
  isSameDay,
  startOfWeek,
} from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useOrganization } from "@/hooks/useOrganization";

interface Props {
  /**
   * Called when the user clicks any day chip. Always receives an
   * `attendance_date` in YYYY-MM-DD form so the parent can route to the
   * correction dialog (or noop when in the future).
   */
  onDayClick?: (date: string, inFuture: boolean) => void;
}

interface ScheduleDay {
  /** Stored as text in DB: either a name ("monday") or numeric string ("1"). Normalised to JS Date.getDay() (0=Sun..6=Sat) on read. */
  day_of_week: number;
  start_time: string | null;
  end_time: string | null;
}

const DOW_NAME_MAP: Record<string, number> = {
  sun: 0, sunday: 0, "0": 0, "7": 0,
  mon: 1, monday: 1, "1": 1,
  tue: 2, tues: 2, tuesday: 2, "2": 2,
  wed: 3, weds: 3, wednesday: 3, "3": 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, "4": 4,
  fri: 5, friday: 5, "5": 5,
  sat: 6, saturday: 6, "6": 6,
};
function normaliseDow(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const key = String(raw).trim().toLowerCase();
  return DOW_NAME_MAP[key] ?? (Number.isFinite(Number(key)) ? Number(key) : null);
}

export function MyWeekStrip({ onDayClick }: Props) {
  const { currentEmployee } = useCurrentEmployee();
  const { currentOrg } = useOrganization();
  const [weekOffset, setWeekOffset] = useState(0);

  const weekStart = useMemo(
    () =>
      addWeeks(
        startOfWeek(new Date(), { weekStartsOn: 1 }),
        weekOffset,
      ),
    [weekOffset],
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekStartStr = format(weekStart, "yyyy-MM-dd");
  const weekEndStr = format(addDays(weekStart, 6), "yyyy-MM-dd");

  // Schedule: one row per day_of_week for the employee's assigned schedule.
  const { data: scheduleDays = [] } = useQuery<ScheduleDay[]>({
    queryKey: ["my-week-schedule", currentEmployee?.id],
    enabled: !!currentEmployee?.id,
    queryFn: async () => {
      const { data: emp } = await supabase
        .from("v_employees_canonical")
        .select("work_schedule_id")
        .eq("id", currentEmployee!.id)
        .maybeSingle();
      const wsId = (emp as any)?.work_schedule_id as string | null | undefined;
      if (!wsId) return [];
      const { data } = await supabase
        .from("work_schedule_days")
        .select("day_of_week, start_time, end_time")
        .eq("schedule_id", wsId);
      return ((data ?? []) as Array<{ day_of_week: unknown; start_time: string | null; end_time: string | null }>)
        .map((r) => ({
          day_of_week: normaliseDow(r.day_of_week) ?? -1,
          start_time: r.start_time,
          end_time: r.end_time,
        }))
        .filter((r) => r.day_of_week >= 0) as ScheduleDay[];
    },
  });

  // Approved leaves overlapping the visible week.
  const { data: leaves = [] } = useQuery<{ start_date: string; end_date: string }[]>({
    queryKey: ["my-week-leaves", currentEmployee?.id, weekStartStr, weekEndStr],
    enabled: !!currentEmployee?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("leave_requests")
        .select("start_date, end_date")
        .eq("employee_id", currentEmployee!.id)
        .eq("status", "approved")
        .lte("start_date", weekEndStr)
        .gte("end_date", weekStartStr);
      return (data ?? []) as { start_date: string; end_date: string }[];
    },
  });

  // Public holidays for the org in the visible week.
  const { data: holidays = [] } = useQuery<{ date: string; name: string }[]>({
    queryKey: ["my-week-holidays", currentOrg?.id, weekStartStr, weekEndStr],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("public_holidays")
        .select("date, name")
        .eq("organization_id", currentOrg!.id)
        .gte("date", weekStartStr)
        .lte("date", weekEndStr);
      return (data ?? []) as { date: string; name: string }[];
    },
  });

  const scheduleByDow = useMemo(() => {
    const m = new Map<number, ScheduleDay>();
    scheduleDays.forEach((d) => m.set(d.day_of_week, d));
    return m;
  }, [scheduleDays]);

  const today = new Date();
  const fmtShift = (s: string | null, e: string | null) => {
    if (!s || !e) return null;
    // Trim seconds — "09:00:00" → "09:00"
    return `${s.slice(0, 5)}–${e.slice(0, 5)}`;
  };

  const isOnLeave = (d: Date) => {
    const ds = format(d, "yyyy-MM-dd");
    return leaves.some((l) => ds >= l.start_date && ds <= l.end_date);
  };
  const holidayFor = (d: Date) => {
    const ds = format(d, "yyyy-MM-dd");
    return holidays.find((h) => h.date === ds) ?? null;
  };

  return (
    <Card>
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">
              Week of {format(weekStart, "MMM d, yyyy")}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setWeekOffset((w) => w - 1)}
              aria-label="Previous week"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {weekOffset !== 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setWeekOffset(0)}
              >
                This week
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setWeekOffset((w) => w + 1)}
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1.5">
          {weekDays.map((d) => {
            const dow = d.getDay();
            const sched = scheduleByDow.get(dow);
            const shift = sched ? fmtShift(sched.start_time, sched.end_time) : null;
            const onLeave = isOnLeave(d);
            const holiday = holidayFor(d);
            const isToday = isSameDay(d, today);
            const inFuture = d > today && !isToday;
            const ds = format(d, "yyyy-MM-dd");

            return (
              <button
                key={ds}
                type="button"
                onClick={() => onDayClick?.(ds, inFuture)}
                className={cn(
                  "flex flex-col items-center rounded-md border p-2 text-center transition-colors",
                  "hover:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-ring",
                  isToday
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background",
                  inFuture && "opacity-80",
                )}
                aria-label={`${format(d, "EEEE, MMM d")}${shift ? ` shift ${shift}` : ""}${onLeave ? ", on leave" : ""}${holiday ? `, ${holiday.name}` : ""}`}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {format(d, "EEE")}
                </span>
                <span
                  className={cn(
                    "text-base font-semibold tabular-nums",
                    isToday && "text-primary",
                  )}
                >
                  {format(d, "d")}
                </span>
                {holiday ? (
                  <Badge
                    variant="outline"
                    className="mt-1 px-1 text-[9px] border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 truncate max-w-full"
                    title={holiday.name}
                  >
                    Holiday
                  </Badge>
                ) : onLeave ? (
                  <Badge
                    variant="outline"
                    className="mt-1 px-1 text-[9px] border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                  >
                    Leave
                  </Badge>
                ) : shift ? (
                  <span className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                    {shift}
                  </span>
                ) : (
                  <span className="mt-1 text-[10px] text-muted-foreground/60">
                    Off
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
