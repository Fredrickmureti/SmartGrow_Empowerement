/**
 * Zone load panel — where in the physical building the work is stacking up.
 *
 * Backlog per zone/location straight from `wms_zone_load`. Bars are relative
 * to the busiest zone; the tint reports risk (overdue/blocked), not volume,
 * so a small-but-late zone is still visibly the problem.
 */
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import { HEALTH_FILL, HEALTH_TEXT, shortAge, type HealthState, type ZoneLoad } from "./contract";

function zoneTone(z: ZoneLoad): HealthState {
  if (z.sla_breached > 0 || z.blocked > 2) return "critical";
  if (z.blocked > 0 || z.oldest_age_seconds > 7200) return "degraded";
  return "healthy";
}

export function ZoneLoadPanel({ zones, limit = 10 }: { zones: ZoneLoad[]; limit?: number }) {
  if (zones.length === 0) {
    return <EmptyState title="No zone load" description="No open work is located in a zone." />;
  }
  const peak = Math.max(1, ...zones.map((z) => z.backlog));

  return (
    <ul className="space-y-2.5">
      {zones.slice(0, limit).map((z, i) => {
        const tone = zoneTone(z);
        return (
          <li key={z.location_id ?? `unassigned-${i}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate font-medium">{z.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <span className={cn("font-semibold", HEALTH_TEXT[tone])}>{z.backlog}</span> open
                {z.blocked > 0 && ` · ${z.blocked} blocked`}
                {z.sla_breached > 0 && ` · ${z.sla_breached} overdue`}
                {" · "}
                {shortAge(z.oldest_age_seconds)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", HEALTH_FILL[tone])}
                style={{ width: `${Math.max(4, Math.round((z.backlog / peak) * 100))}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
