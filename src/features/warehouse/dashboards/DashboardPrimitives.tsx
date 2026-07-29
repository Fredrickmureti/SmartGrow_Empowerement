/**
 * Shared presentation primitives for the WMS role dashboards (Phase 4 §6).
 *
 * Deliberately dumb: no data fetching, no business rules. Each dashboard
 * owns its queries (so the realtime key prefixes stay explicit at the call
 * site) and hands rows here purely for rendering.
 */
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export type Tone = "ok" | "warn" | "bad" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  neutral: "text-foreground",
};

export interface MetricTileProps {
  label: string;
  value: number | string;
  sub?: string;
  icon?: LucideIcon;
  tone?: Tone;
  to?: string;
}

export function MetricTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = "neutral",
  to,
}: MetricTileProps) {
  const body = (
    <Card className={cn(to && "transition-colors hover:border-primary/50")}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : null}
        </div>
        <p className={cn("mt-2 text-2xl font-semibold tabular-nums", TONE_TEXT[tone])}>
          {value}
        </p>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export interface StateBreakdownProps {
  rows: Array<Record<string, unknown>>;
  /** Column to group by. Defaults to `state`. */
  field?: string;
  emptyLabel?: string;
}

/** Counts `rows` by `field` and renders a sorted bar list. */
export function StateBreakdown({
  rows,
  field = "state",
  emptyLabel = "Nothing here right now.",
}: StateBreakdownProps) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = String(r[field] ?? "—");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const max = entries[0][1];
  return (
    <ul className="space-y-2">
      {entries.map(([key, count]) => (
        <li key={key} className="flex items-center gap-3 text-sm">
          <span className="w-40 shrink-0 truncate capitalize">
            {key.replace(/_/g, " ")}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
            />
          </span>
          <span className="w-10 shrink-0 text-right font-mono">{count}</span>
        </li>
      ))}
    </ul>
  );
}
