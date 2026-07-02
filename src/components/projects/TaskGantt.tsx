/**
 * TaskGantt — lightweight SVG Gantt chart for a project's tasks.
 *
 * Reads tasks (start_date, deadline, progress) plus depends_on[] arrays
 * to draw FS (finish-to-start) dependency arrows. No external Gantt lib.
 *
 * - Today line, weekend shading
 * - Bars are color-tinted by stage (or muted if no stage)
 * - Click bar → opens TaskDetail via onTaskClick
 * - Tasks without start AND deadline are listed in a "Not scheduled" footer
 */
import { useMemo } from "react";
import { ProjectTask } from "@/hooks/projects/useProjectTasks";
import { Card, CardContent } from "@/components/ui/card";
import {
  addDays, differenceInCalendarDays, eachDayOfInterval, format,
  isWeekend, max as dmax, min as dmin, parseISO, startOfDay,
} from "date-fns";

interface TaskGanttProps {
  tasks: ProjectTask[];
  onTaskClick?: (task: ProjectTask) => void;
}

const ROW_H = 28;
const BAR_H = 16;
const HEADER_H = 36;
const COL_W = 22;
const LEFT_W = 220;

export function TaskGantt({ tasks, onTaskClick }: TaskGanttProps) {
  const scheduled = useMemo(
    () => tasks.filter((t) => t.start_date || t.deadline),
    [tasks],
  );
  const unscheduled = useMemo(
    () => tasks.filter((t) => !t.start_date && !t.deadline),
    [tasks],
  );

  const range = useMemo(() => {
    if (scheduled.length === 0) {
      const today = startOfDay(new Date());
      return { start: today, end: addDays(today, 14) };
    }
    const dates: Date[] = [];
    for (const t of scheduled) {
      if (t.start_date) dates.push(parseISO(t.start_date));
      if (t.deadline) dates.push(parseISO(t.deadline));
    }
    const start = startOfDay(addDays(dmin(dates), -2));
    const end = startOfDay(addDays(dmax(dates), 2));
    return { start, end };
  }, [scheduled]);

  const days = useMemo(
    () => eachDayOfInterval({ start: range.start, end: range.end }),
    [range],
  );

  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    scheduled.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [scheduled]);

  const width = LEFT_W + days.length * COL_W;
  const height = HEADER_H + Math.max(scheduled.length, 1) * ROW_H + 12;

  const xForDate = (d: string | Date) => {
    const dt = typeof d === "string" ? parseISO(d) : d;
    return LEFT_W + differenceInCalendarDays(dt, range.start) * COL_W;
  };

  const todayX = xForDate(startOfDay(new Date()));

  return (
    <Card>
      <CardContent className="pt-4 overflow-x-auto">
        {scheduled.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scheduled tasks. Add a start date or deadline to see them on the timeline.</p>
        ) : (
          <svg width={width} height={height} className="text-xs">
            {/* weekend shading */}
            {days.map((d, i) => isWeekend(d) ? (
              <rect key={`w-${i}`} x={LEFT_W + i * COL_W} y={HEADER_H} width={COL_W} height={height - HEADER_H}
                className="fill-muted/40" />
            ) : null)}

            {/* day header */}
            {days.map((d, i) => (
              <g key={`h-${i}`}>
                <line x1={LEFT_W + i * COL_W} y1={HEADER_H} x2={LEFT_W + i * COL_W} y2={height}
                  className="stroke-border" strokeWidth={0.5} />
                {d.getDate() === 1 || i === 0 ? (
                  <text x={LEFT_W + i * COL_W + 2} y={14} className="fill-foreground font-medium">
                    {format(d, "MMM yyyy")}
                  </text>
                ) : null}
                <text x={LEFT_W + i * COL_W + COL_W / 2} y={30} textAnchor="middle"
                  className="fill-muted-foreground">{d.getDate()}</text>
              </g>
            ))}

            {/* today marker */}
            {todayX >= LEFT_W && todayX <= width && (
              <line x1={todayX} y1={HEADER_H - 2} x2={todayX} y2={height}
                className="stroke-primary" strokeWidth={1.5} strokeDasharray="3 2" />
            )}

            {/* row labels + bars */}
            {scheduled.map((t, i) => {
              const start = t.start_date ? parseISO(t.start_date) : (t.deadline ? parseISO(t.deadline) : range.start);
              const end = t.deadline ? parseISO(t.deadline) : (t.start_date ? parseISO(t.start_date) : start);
              const x1 = xForDate(start);
              const x2 = xForDate(addDays(end, 1));
              const y = HEADER_H + i * ROW_H + (ROW_H - BAR_H) / 2;
              const w = Math.max(8, x2 - x1);
              const progressW = Math.max(0, Math.min(w, (w * (t.progress ?? 0)) / 100));
              const fill = t.stage?.color || "hsl(var(--muted))";
              return (
                <g key={t.id} className="cursor-pointer" onClick={() => onTaskClick?.(t)}>
                  {/* row label */}
                  <text x={8} y={y + BAR_H - 3} className="fill-foreground"
                    style={{ fontWeight: t.is_done ? 400 : 500 }}>
                    {(t.task_number ? `${t.task_number} ` : "") + (t.name.length > 26 ? t.name.slice(0, 24) + "…" : t.name)}
                  </text>
                  {/* bar */}
                  <rect x={x1} y={y} width={w} height={BAR_H} rx={3}
                    fill={fill} opacity={t.is_done ? 0.45 : 0.85}
                    className={t.is_blocked ? "stroke-destructive" : "stroke-border"}
                    strokeWidth={t.is_blocked ? 1.5 : 0.5} />
                  {/* progress overlay */}
                  {progressW > 0 && (
                    <rect x={x1} y={y} width={progressW} height={BAR_H} rx={3}
                      className="fill-primary/70" />
                  )}
                  <title>{`${t.name}\n${t.start_date ?? "?"} → ${t.deadline ?? "?"}\nProgress: ${t.progress ?? 0}%${t.is_blocked ? "\n⚠ Blocked" : ""}`}</title>
                </g>
              );
            })}

            {/* dependency arrows (FS) */}
            {scheduled.map((t) => {
              const deps = t.depends_on ?? [];
              return deps.map((depId) => {
                const fromIdx = indexById.get(depId);
                const toIdx = indexById.get(t.id);
                if (fromIdx === undefined || toIdx === undefined) return null;
                const from = scheduled[fromIdx];
                const fromEnd = from.deadline ? parseISO(from.deadline) : (from.start_date ? parseISO(from.start_date) : range.start);
                const toStart = t.start_date ? parseISO(t.start_date) : (t.deadline ? parseISO(t.deadline) : range.start);
                const x1 = xForDate(addDays(fromEnd, 1));
                const y1 = HEADER_H + fromIdx * ROW_H + ROW_H / 2;
                const x2 = xForDate(toStart);
                const y2 = HEADER_H + toIdx * ROW_H + ROW_H / 2;
                const mx = x1 + 6;
                return (
                  <path key={`dep-${depId}-${t.id}`}
                    d={`M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`}
                    fill="none" className="stroke-muted-foreground/60" strokeWidth={1}
                    markerEnd="url(#gantt-arrow)" />
                );
              });
            })}

            <defs>
              <marker id="gantt-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground/60" />
              </marker>
            </defs>
          </svg>
        )}

        {unscheduled.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground mb-1">Not scheduled ({unscheduled.length})</p>
            <div className="flex flex-wrap gap-1">
              {unscheduled.map((t) => (
                <button key={t.id} onClick={() => onTaskClick?.(t)}
                  className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/70">
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
