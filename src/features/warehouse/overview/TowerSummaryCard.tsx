/**
 * Tower summary strip — the inbound / outbound headline on the Overview.
 *
 * Consumes the tower's own health contract (`wms_inbound_health`,
 * `wms_outbound_health`) and never re-derives it. The strip answers
 * "is this side of the building flowing?" and hands off to the tower.
 */
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  HEALTH_FILL, HEALTH_LABEL, HEALTH_TEXT, shortAge,
  type FlowStageHealth, type HealthState,
} from "@/features/warehouse/control-center/contract";

interface TowerHealthLike {
  overall: HealthState;
  reason: string;
  stages: FlowStageHealth[];
}

export function TowerSummaryCard({
  title,
  health,
  route,
  ctaLabel,
}: {
  title: string;
  health: TowerHealthLike | undefined;
  route: string;
  ctaLabel: string;
}) {
  const state: HealthState = health?.overall ?? "healthy";
  const stages = health?.stages ?? [];
  const backlog = stages.reduce((n, s) => n + s.backlog, 0);
  const breached = stages.reduce((n, s) => n + s.sla_breached, 0);
  const blocked = stages.reduce((n, s) => n + s.blocked, 0);
  const oldest = stages.reduce((n, s) => Math.max(n, s.oldest_age_seconds), 0);
  const peak = Math.max(1, ...stages.map((s) => s.backlog + s.in_progress));

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="truncate text-sm font-semibold">{title}</CardTitle>
        <span className={cn("shrink-0 text-xs font-medium", HEALTH_TEXT[state])}>
          {HEALTH_LABEL[state]}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="line-clamp-2 break-words text-sm text-muted-foreground">
          {health?.reason ?? "No open work."}
        </p>

        <div className="flex min-w-0 items-end gap-1 overflow-hidden">
          {stages.map((s) => {
            const total = s.backlog + s.in_progress;
            return (
              <div key={s.stage} className="min-w-0 flex-1 space-y-1" title={`${s.label}: ${total} open`}>
                <div className="flex h-12 items-end">
                  <div
                    className={cn("w-full rounded-sm", HEALTH_FILL[s.health])}
                    style={{ height: `${Math.max(6, (total / peak) * 100)}%` }}
                  />
                </div>
                <div className="truncate text-center text-[10px] text-muted-foreground">
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>

        <dl className="grid grid-cols-2 gap-2 text-sm @xs/card:grid-cols-4">
          <Stat label="Open" value={backlog} />
          <Stat label="Blocked" value={blocked} tone={blocked > 0 ? "blocked" : undefined} />
          <Stat label="Overdue" value={breached} tone={breached > 0 ? "critical" : undefined} />
          <div className="min-w-0">
            <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Oldest</dt>
            <dd className="text-base font-semibold tabular-nums">{shortAge(oldest)}</dd>
          </div>
        </dl>

        <Button asChild variant="ghost" size="sm" className="w-full justify-between">
          <Link to={route}>
            {ctaLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: HealthState }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("text-base font-semibold tabular-nums", tone && HEALTH_TEXT[tone])}>
        {value}
      </dd>
    </div>
  );
}

export default TowerSummaryCard;
