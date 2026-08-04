/**
 * Health banner — the answer to "is the warehouse healthy?" in one glance.
 *
 * One computed state, the reason that produced it, the worst stage, and the
 * headline risk counters rolled up from the server contract. This is the
 * only element on the page a supervisor should have to read to know whether
 * to intervene.
 */
import { motion } from "framer-motion";
import { Activity, AlertOctagon, AlertTriangle, CheckCircle2, Ban } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HEALTH_LABEL, HEALTH_SURFACE, HEALTH_TEXT, shortAge,
  type FlowHealth, type HealthState,
} from "./contract";

const ICON: Record<HealthState, LucideIcon> = {
  healthy: CheckCircle2,
  degraded: AlertTriangle,
  critical: AlertOctagon,
  blocked: Ban,
};

interface Props {
  health: FlowHealth | undefined;
  generatedAt?: string;
}

export function HealthBanner({ health }: Props) {
  const state: HealthState = health?.overall ?? "healthy";
  const Icon = ICON[state];
  const stages = health?.stages ?? [];

  const breached = stages.reduce((n, s) => n + s.sla_breached, 0);
  const atRisk = stages.reduce((n, s) => n + s.sla_at_risk, 0);
  const blocked = stages.reduce((n, s) => n + s.blocked, 0);
  const backlog = stages.reduce((n, s) => n + s.backlog, 0);
  const oldest = stages.reduce((n, s) => Math.max(n, s.oldest_age_seconds), 0);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-lg border p-4 sm:p-5",
        HEALTH_SURFACE[state],
      )}
    >
      <div className="flex flex-col gap-4 @xl/page:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Icon className={cn("mt-0.5 h-7 w-7 shrink-0", HEALTH_TEXT[state])} />
          <div>
            <div className="flex items-center gap-2">
              <p className={cn("text-xl font-semibold", HEALTH_TEXT[state])}>
                Warehouse {HEALTH_LABEL[state].toLowerCase()}
              </p>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Activity className="h-3 w-3" /> live
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {health?.reason ?? "Waiting for the first health read."}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @xl/page:grid-cols-5 sm:gap-x-8">
          <Counter label="Overdue" value={breached} tone={breached > 0 ? "critical" : "healthy"} />
          <Counter label="At risk" value={atRisk} tone={atRisk > 0 ? "degraded" : "healthy"} />
          <Counter label="Blocked" value={blocked} tone={blocked > 0 ? "critical" : "healthy"} />
          <Counter label="Open work" value={backlog} tone="healthy" plain />
          <Counter label="Oldest" value={shortAge(oldest)} tone="healthy" plain />
        </dl>
      </div>
    </motion.div>
  );
}

function Counter({
  label, value, tone, plain,
}: { label: string; value: number | string; tone: HealthState; plain?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-lg font-semibold tabular-nums",
          plain ? "text-foreground" : HEALTH_TEXT[tone],
        )}
      >
        {value}
      </dd>
    </div>
  );
}
