/**
 * EmployeeTrendDrawer — 30-day worked-vs-scheduled sparkline + late count
 * + last 10 attendance events for one employee. Read-only.
 *
 * Two render modes:
 *   - mode="drawer" (default) — opens in a right-side Sheet, driven by
 *     `open` + `onOpenChange`. Used from row clicks in My Team / Today.
 *   - mode="inline" — renders the panel body directly (no Sheet shell),
 *     suitable for embedding in a profile Overview pane. `open` is
 *     treated as `true` and the query runs whenever `employeeId` is set.
 */
import { useMemo } from "react";
import { format, subDays } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  employeeId: string | null;
  employeeName: string;
  standardHoursPerDay?: number;
  /** Drawer mode only — ignored when mode="inline". */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  mode?: "drawer" | "inline";
}

export function EmployeeTrendDrawer({
  employeeId,
  employeeName,
  standardHoursPerDay = 8,
  open,
  onOpenChange,
  mode = "drawer",
}: Props) {
  const isInline = mode === "inline";
  const isActive = isInline ? true : !!open;

  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subDays(new Date(), 29), "yyyy-MM-dd");

  const { data: records = [], isLoading } = useQuery({
    queryKey: ["attendance-trend", employeeId, from, to],
    enabled: !!employeeId && isActive,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance" as any)
        .select(
          "id, attendance_date, status, worked_hours, overtime_hours, late_minutes, clock_in, clock_out",
        )
        .eq("employee_id", employeeId!)
        .gte("attendance_date", from)
        .lte("attendance_date", to)
        .order("attendance_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const { data: events = [] } = useQuery({
    queryKey: ["attendance-events-recent", employeeId],
    enabled: !!employeeId && isActive,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance_events" as any)
        .select("id, event_type, outcome, created_at, event_time, metadata")
        .eq("employee_id", employeeId!)
        .order("event_time", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return ((data ?? []) as any[]).map((e) => ({
        ...e,
        // Display the truthful punch time when present.
        created_at: e.event_time ?? e.created_at,
      }));
    },
  });

  const stats = useMemo(() => {
    const lateDays = records.filter(
      (r) => r.status === "late" || (r.late_minutes ?? 0) > 0,
    ).length;
    const totalHours = records.reduce(
      (s, r) => s + Number(r.worked_hours ?? 0),
      0,
    );
    const otHours = records.reduce(
      (s, r) => s + Number(r.overtime_hours ?? 0),
      0,
    );
    const present = records.filter(
      (r) => r.status === "present" || r.status === "late",
    ).length;
    return { lateDays, totalHours, otHours, present };
  }, [records]);

  // Sparkline data: per day, worked vs scheduled (0/standard for days off).
  const maxHours = Math.max(standardHoursPerDay * 1.5, 8);

  const body = isLoading ? (
    <div className="flex justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  ) : (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Present" value={stats.present} />
        <StatCard label="Late" value={stats.lateDays} tone="amber" />
        <StatCard label="Hours" value={stats.totalHours.toFixed(0)} />
        <StatCard label="OT" value={stats.otHours.toFixed(0)} />
      </div>

      <Card>
        <CardContent className="p-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Daily worked hours
          </p>
          <div className="flex items-end gap-[2px] h-24">
            {records.length === 0 ? (
              <p className="text-xs text-muted-foreground">No records.</p>
            ) : (
              records.map((r) => {
                const h = Number(r.worked_hours ?? 0);
                const pct = Math.min(100, (h / maxHours) * 100);
                const isLate =
                  r.status === "late" || (r.late_minutes ?? 0) > 0;
                return (
                  <div
                    key={r.id}
                    title={`${r.attendance_date}: ${h.toFixed(1)}h${isLate ? " · late" : ""}`}
                    className="flex-1 rounded-sm"
                    style={{
                      height: `${Math.max(pct, 2)}%`,
                      background: isLate
                        ? "hsl(var(--destructive))"
                        : "hsl(var(--primary))",
                      opacity: h > 0 ? 1 : 0.2,
                    }}
                  />
                );
              })
            )}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{format(new Date(from), "MMM d")}</span>
            <span>{format(new Date(to), "MMM d")}</span>
          </div>
        </CardContent>
      </Card>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Recent events
        </p>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events.</p>
        ) : (
          <ul className="space-y-1">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between text-xs border-b py-1"
              >
                <span className="flex items-center gap-2">
                  <Badge
                    variant={e.outcome === "deny" ? "destructive" : "outline"}
                    className="h-4 px-1 text-[10px]"
                  >
                    {e.event_type}
                  </Badge>
                  <span className="text-muted-foreground">{e.outcome}</span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {format(new Date(e.created_at), "MMM d, hh:mm a")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  if (isInline) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Last 30 days · worked vs scheduled
          </CardTitle>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    );
  }

  return (
    <Sheet open={!!open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            {employeeName}
          </SheetTitle>
          <SheetDescription>Last 30 days · worked vs scheduled</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}


function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "amber";
}) {
  return (
    <Card>
      <CardContent className="p-2">
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p
          className={
            "text-lg font-bold tabular-nums " +
            (tone === "amber" ? "text-amber-600" : "")
          }
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
