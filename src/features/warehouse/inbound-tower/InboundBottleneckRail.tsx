/**
 * Inbound bottleneck rail — ranked causes, each linked to the surface that
 * clears it. Straight from `wms_inbound_bottlenecks`; no client ranking and
 * no client classification of exception text.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import {
  HEALTH_TEXT, INBOUND_REASON_ACTION, INBOUND_REASON_LABEL, humanise,
  type InboundBottleneck,
} from "./contract";

/** Severity on the inbound contract is 0–100, not the 1–3 flow scale. */
function tone(severity: number) {
  if (severity >= 80) return "critical" as const;
  if (severity >= 60) return "degraded" as const;
  return "healthy" as const;
}

export function InboundBottleneckRail({
  bottlenecks, limit = 10,
}: { bottlenecks: InboundBottleneck[]; limit?: number }) {
  if (bottlenecks.length === 0) {
    return (
      <EmptyState
        title="Nothing blocking receipt"
        description="No arrival is late, stuck in the yard, short, held in QC or waiting on put-away."
      />
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {bottlenecks.slice(0, limit).map((b, i) => {
        const t = tone(b.severity);
        return (
          <li key={`${b.reason_code}-${b.scope}-${i}`}>
            <Link
              to={b.route}
              className="flex items-center gap-3 p-3 transition-colors hover:bg-muted/50"
            >
              <span
                className={cn(
                  "w-1 shrink-0 self-stretch rounded-full",
                  t === "critical" ? "bg-destructive" : t === "degraded" ? "bg-warning" : "bg-muted",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={cn("text-xs font-semibold uppercase", HEALTH_TEXT[t])}>
                    {INBOUND_REASON_LABEL[b.reason_code] ?? humanise(b.reason_code)}
                  </span>
                  <span className="text-xs text-muted-foreground">{humanise(b.scope)}</span>
                </span>
                <span className="block truncate text-sm">{b.reason}</span>
                <span className="block text-xs text-muted-foreground">
                  {INBOUND_REASON_ACTION[b.reason_code]}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold tabular-nums">
                  {b.impact_count}
                </span>
                <span className="text-[11px] text-muted-foreground">items</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
