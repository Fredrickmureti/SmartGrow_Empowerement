/**
 * Shared presentation primitives for the WMS role dashboards (Phase 4 §6).
 *
 * Deliberately dumb: no data fetching, no business rules. Each dashboard
 * owns its queries (so the realtime key prefixes stay explicit at the call
 * site) and hands rows here purely for rendering.
 *
 * NOTE: `MetricTile` is a **deprecated compatibility wrapper** over the
 * canonical `SummaryStatCard`. New Warehouse code must import
 * `SummaryStatCard` / `SummaryStatGrid` from `@/design-system` directly.
 * This wrapper exists only so already-migrated dashboards keep their prop
 * names during the Warehouse card consolidation, and is deleted at the end.
 */
import { SummaryStatCard } from "@/design-system";
import type { LucideIcon } from "lucide-react";

export type Tone = "ok" | "warn" | "bad" | "neutral";

export interface MetricTileProps {
  label: string;
  value: number | string;
  sub?: string;
  icon?: LucideIcon;
  tone?: Tone;
  to?: string;
}

/** @deprecated Use `SummaryStatCard` from `@/design-system`. */
export function MetricTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = "neutral",
  to,
}: MetricTileProps) {
  return (
    <SummaryStatCard
      label={label}
      value={value}
      footer={sub}
      icon={Icon ? <Icon className="h-3.5 w-3.5" /> : undefined}
      tone={tone}
      to={to}
    />
  );
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
