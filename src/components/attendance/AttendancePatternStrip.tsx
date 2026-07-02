/**
 * AttendancePatternStrip — surfaces trend deltas and chronic-late employees
 * for the Reports page. Pure derivation from the records already loaded —
 * no new queries.
 */
import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, ArrowUp, Minus, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AttendanceRecord } from "@/hooks/useAttendance";

interface Props {
  /** All records in the current report range. */
  currentRange: AttendanceRecord[];
  /** Same-length comparable previous-period records. May be empty. */
  previousRange?: AttendanceRecord[];
}

function sumLate(rows: AttendanceRecord[]) {
  return rows.reduce((s, r) => s + ((r as any).late_minutes > 0 ? 1 : 0), 0);
}
function sumAbsent(rows: AttendanceRecord[]) {
  return rows.reduce((s, r) => s + (r.status === "absent" ? 1 : 0), 0);
}
function sumOt(rows: AttendanceRecord[]) {
  return rows.reduce((s, r) => s + (r.overtime_hours ?? 0), 0);
}

function Delta({ now, prev, suffix }: { now: number; prev: number; suffix?: string }) {
  if (!prev || prev === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const pct = Math.round(((now - prev) / prev) * 100);
  const isUp = pct > 0;
  const Icon = pct === 0 ? Minus : isUp ? ArrowUp : ArrowDown;
  // Up is bad for late/absent/OT — always tone as warning for >0, success for <0.
  const tone =
    pct === 0
      ? "text-muted-foreground"
      : isUp
        ? "text-rose-600 dark:text-rose-400"
        : "text-emerald-600 dark:text-emerald-400";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs", tone)}>
      <Icon className="h-3 w-3" />
      {Math.abs(pct)}%{suffix ?? ""}
    </span>
  );
}

export function AttendancePatternStrip({ currentRange, previousRange = [] }: Props) {
  const lateNow = sumLate(currentRange);
  const lateThen = sumLate(previousRange);
  const absentNow = sumAbsent(currentRange);
  const absentThen = sumAbsent(previousRange);
  const otNow = sumOt(currentRange);
  const otThen = sumOt(previousRange);

  const topChronic = useMemo(() => {
    const counts = new Map<string, { name: string; lateCount: number }>();
    for (const r of currentRange) {
      if (!(r as any).late_minutes || (r as any).late_minutes <= 0) continue;
      const id = r.employee_id;
      const name = r.employee
        ? `${r.employee.first_name} ${r.employee.last_name}`
        : "Unknown";
      const prev = counts.get(id);
      counts.set(id, { name, lateCount: (prev?.lateCount ?? 0) + 1 });
    }
    return Array.from(counts.values())
      .sort((a, b) => b.lateCount - a.lateCount)
      .slice(0, 5);
  }, [currentRange]);

  return (
    <Card>
      <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" />
            Trend vs previous period
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-2xl font-semibold tabular-nums">{lateNow}</div>
              <div className="text-xs text-muted-foreground">Late incidents</div>
              <Delta now={lateNow} prev={lateThen} />
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{absentNow}</div>
              <div className="text-xs text-muted-foreground">Absences</div>
              <Delta now={absentNow} prev={absentThen} />
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">
                {otNow.toFixed(1)}h
              </div>
              <div className="text-xs text-muted-foreground">Overtime</div>
              <Delta now={otNow} prev={otThen} />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Top chronic late arrivals
          </div>
          {topChronic.length === 0 ? (
            <p className="text-xs text-muted-foreground">No late incidents in this range.</p>
          ) : (
            <ul className="space-y-1">
              {topChronic.map((t) => (
                <li
                  key={t.name}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="truncate">{t.name}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {t.lateCount} day{t.lateCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}