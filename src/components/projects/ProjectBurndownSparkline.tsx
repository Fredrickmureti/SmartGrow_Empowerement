/**
 * ProjectBurndownSparkline — reads from the `project_burndown_daily` snapshot
 * table (populated by the daily SQL cron `snapshot-project-burndown-daily`).
 * Pure render: O(days) — no on-the-fly aggregation over timesheets/tasks.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingDown } from "lucide-react";
import { format, parseISO } from "date-fns";

interface Snapshot {
  snapshot_date: string;
  remaining_hours: number;
  logged_hours: number;
  planned_hours: number;
}

interface Props {
  projectId: string;
  days?: number;
}

export function ProjectBurndownSparkline({ projectId, days = 30 }: Props) {
  const [rows, setRows] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("project_burndown_daily")
        .select("snapshot_date, remaining_hours, logged_hours, planned_hours")
        .eq("project_id", projectId)
        .order("snapshot_date", { ascending: true })
        .limit(days);
      if (!cancelled) {
        setRows((data ?? []) as Snapshot[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, days]);

  if (loading) return null;

  const W = 320;
  const H = 60;
  const PAD = 4;

  const latest = rows[rows.length - 1];
  const first = rows[0];

  if (rows.length < 2) {
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <TrendingDown className="h-3.5 w-3.5" /> Burndown · {days}d
          </div>
          <p className="text-xs text-muted-foreground">
            Snapshots build up daily. Check back tomorrow.
          </p>
        </CardContent>
      </Card>
    );
  }

  const max = Math.max(...rows.map((r) => r.remaining_hours), 1);
  const xStep = (W - PAD * 2) / Math.max(rows.length - 1, 1);
  const points = rows
    .map(
      (r, i) =>
        `${PAD + i * xStep},${H - PAD - (r.remaining_hours / max) * (H - PAD * 2)}`
    )
    .join(" ");

  const trend = latest.remaining_hours - first.remaining_hours;
  const trendColor =
    trend < 0 ? "text-emerald-600" : trend > 0 ? "text-rose-600" : "text-muted-foreground";

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <TrendingDown className="h-3.5 w-3.5" /> Burndown · {rows.length}d
          </div>
          <span className={`text-xs font-medium ${trendColor}`}>
            {trend > 0 ? "+" : ""}
            {trend.toFixed(1)}h
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16">
          <polyline
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="2"
            points={points}
          />
        </svg>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{format(parseISO(first.snapshot_date), "MMM d")}</span>
          <span>{latest.remaining_hours.toFixed(1)}h remaining</span>
          <span>{format(parseISO(latest.snapshot_date), "MMM d")}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default ProjectBurndownSparkline;