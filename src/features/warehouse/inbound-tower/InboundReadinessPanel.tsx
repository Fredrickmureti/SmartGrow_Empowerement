/**
 * Downstream readiness — inspection, cross-dock and put-away.
 *
 * The tail of the inbound spine decides whether received stock actually
 * becomes sellable. These three stages come straight off
 * `wms_inbound_health.stages`; nothing here counts, ranks or classifies —
 * the server already did, and each tile links to the surface that clears it.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import {
  HEALTH_LABEL, HEALTH_SURFACE, HEALTH_TEXT, shortAge,
  type FlowStageHealth,
} from "./contract";

/** The stages that stand between a captured receipt and available stock. */
const TAIL_STAGES = ["inspect", "crossdock", "putaway"] as const;

export function InboundReadinessPanel({ stages }: { stages: FlowStageHealth[] }) {
  const tail = TAIL_STAGES
    .map((s) => stages.find((st) => st.stage === (s as FlowStageHealth["stage"])))
    .filter((s): s is FlowStageHealth => !!s);

  if (tail.length === 0) {
    return (
      <EmptyState
        title="No downstream work"
        description="Nothing is waiting on inspection, a cross-dock decision or put-away."
      />
    );
  }

  return (
    <ul className="space-y-2">
      {tail.map((s) => (
        <li key={s.stage}>
          <Link
            to={s.drill_route}
            className={cn(
              "flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50",
              HEALTH_SURFACE[s.health],
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{s.label}</span>
                <span className={cn("text-[11px] font-semibold uppercase", HEALTH_TEXT[s.health])}>
                  {HEALTH_LABEL[s.health]}
                </span>
              </span>
              <span className="block text-xs text-muted-foreground">
                {s.backlog} waiting · {s.in_progress} in progress · {s.blocked} blocked
                {s.oldest_age_seconds > 0 ? ` · oldest ${shortAge(s.oldest_age_seconds)}` : ""}
              </span>
              {(s.sla_at_risk > 0 || s.sla_breached > 0) && (
                <span className="block text-xs text-muted-foreground">
                  {s.sla_breached} breached · {s.sla_at_risk} at risk
                </span>
              )}
            </span>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
