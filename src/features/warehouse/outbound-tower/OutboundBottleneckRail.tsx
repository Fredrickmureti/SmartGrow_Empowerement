/**
 * Outbound bottleneck rail — ranked causes, each linked to the surface that
 * clears it. Straight from `wms_outbound_bottlenecks`; no client ranking.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import { severityTone } from "@/features/warehouse/control-center/contract";
import {
  HEALTH_TEXT, OUTBOUND_REASON_ACTION, OUTBOUND_REASON_LABEL, humanise,
  type OutboundBottleneck,
} from "./contract";

export function OutboundBottleneckRail({
  bottlenecks, limit = 10,
}: { bottlenecks: OutboundBottleneck[]; limit?: number }) {
  if (bottlenecks.length === 0) {
    return (
      <EmptyState
        title="Nothing blocking dispatch"
        description="No load is late, short, undocked or missing proof."
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
                    {OUTBOUND_REASON_LABEL[b.reason_code] ?? humanise(b.reason_code)}
                  </span>
                  <span className="text-xs text-muted-foreground">{humanise(b.scope)}</span>
                </span>
                <span className="block truncate text-sm">{b.reason}</span>
                <span className="block text-xs text-muted-foreground">
                  {OUTBOUND_REASON_ACTION[b.reason_code]}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold tabular-nums">
                  {b.impact_count}
                </span>
                <span className="text-[11px] text-muted-foreground">loads</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
