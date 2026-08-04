/**
 * Priority stack — "what should I address first?".
 *
 * The merged, ranked view of every bottleneck feed (flow, inbound,
 * outbound). Each row is a cause, not a metric, and links to the surface
 * that clears it. Ranking is pure — severity and impact come from SQL.
 */
import { Link } from "react-router-dom";
import { ArrowRight, AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/design-system";
import { HEALTH_TEXT, humanise, severityTone } from "@/features/warehouse/control-center/contract";
import { ORIGIN_LABEL, type PriorityItem } from "./contract";

const ICON = {
  critical: AlertOctagon,
  blocked: AlertOctagon,
  degraded: AlertTriangle,
  healthy: Info,
} as const;

export function PriorityStack({
  items,
  limit = 5,
}: {
  items: PriorityItem[];
  limit?: number;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing needs attention"
        description="No blocker is currently ranked above the noise floor across flow, inbound or outbound."
      />
    );
  }

  return (
    <ol className="space-y-2">
      {items.slice(0, limit).map((item, index) => {
        const tone = severityTone(item.severity);
        const Icon = ICON[tone];
        return (
          <li key={item.key}>
            <Link
              to={item.route}
              className={cn(
                "group flex items-start gap-3 rounded-lg border p-3 transition-colors",
                "hover:bg-muted/50",
                index === 0 && tone !== "healthy" && "border-current/30",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums",
                  HEALTH_TEXT[tone],
                )}
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon className={cn("h-4 w-4 shrink-0", HEALTH_TEXT[tone])} />
                  <span className="text-sm font-medium">{humanise(item.reason_code)}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {ORIGIN_LABEL[item.origin]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{item.scope}</span>
                </div>
                <p className="text-sm text-muted-foreground">{item.reason}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 pl-2 text-right">
                <div>
                  <div className="text-sm font-semibold tabular-nums">{item.impact_count}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    affected
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export default PriorityStack;
