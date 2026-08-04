/**
 * Bottleneck rail — the answer to "where is work backing up, and why?".
 *
 * Ranked by severity then impact, straight from `wms_flow_bottlenecks`.
 * Every row names the cause, the number of items affected, and the surface
 * that owns the fix. If this rail is empty, the warehouse has no operational
 * blockers — which is itself the answer a supervisor wants.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import {
  HEALTH_TEXT, REASON_ACTION, REASON_LABEL, humanise, severityTone,
  type Bottleneck,
} from "./contract";

interface Props {
  bottlenecks: Bottleneck[];
  limit?: number;
}

export function BottleneckRail({ bottlenecks, limit = 12 }: Props) {
  if (bottlenecks.length === 0) {
    return (
      <EmptyState
        title="No bottlenecks"
        description="No stage is late, blocked, starved or unstaffed right now."
      />
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {bottlenecks.slice(0, limit).map((b, i) => {
        const tone = severityTone(b.severity);
        return (
          <li key={`${b.reason_code}-${b.scope}-${i}`}>
            <Link
              to={b.route}
              className="flex items-center gap-3 p-3 transition-colors hover:bg-muted/50"
            >
              <span
                className={cn(
                  "w-1 shrink-0 self-stretch rounded-full",
                  tone === "critical" ? "bg-destructive" : "bg-warning",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={cn("text-xs font-semibold uppercase", HEALTH_TEXT[tone])}>
                    {REASON_LABEL[b.reason_code] ?? humanise(b.reason_code)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {humanise(b.scope)}
                  </span>
                </span>
                <span className="block truncate text-sm">{b.reason}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-lg font-semibold tabular-nums leading-none">
                  {b.impact_count}
                </span>
                <span className="block text-[11px] text-muted-foreground">affected</span>
              </span>
              <span className="hidden w-40 shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground sm:flex">
                {REASON_ACTION[b.reason_code] ?? "Investigate"}
                <ArrowUpRight className="h-3 w-3" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
