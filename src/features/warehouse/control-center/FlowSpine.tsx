/**
 * Flow spine — the warehouse as a flow, not as a pile of cards.
 *
 * Receive → Inspect → Put-away → Store → Replenish → Pick → Pack → Load →
 * Dispatch. Each stage renders its own health, its backlog, the age of its
 * oldest item and its SLA risk, and the connector between two stages is
 * tinted by the downstream stage's health so a supervisor's eye lands on
 * the bottleneck rather than on a number.
 */
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HEALTH_FILL, HEALTH_LABEL, HEALTH_SURFACE, HEALTH_TEXT, shortAge,
  type FlowStageHealth,
} from "./contract";

interface Props {
  stages: FlowStageHealth[];
  /** Highlights the currently drilled stage. */
  activeStage?: string | null;
  onSelect?: (stage: FlowStageHealth) => void;
}

export function FlowSpine({ stages, activeStage, onSelect }: Props) {
  if (stages.length === 0) return null;
  const peak = Math.max(1, ...stages.map((s) => s.backlog));

  return (
    <div className="pb-1 @4xl/page:overflow-x-auto">
      <ol className="grid grid-cols-1 gap-3 @md/page:grid-cols-2 @2xl/page:grid-cols-3 @4xl/page:flex @4xl/page:min-w-max @4xl/page:items-stretch @4xl/page:gap-1">
        {stages.map((s, i) => (
          <li key={s.stage} className="flex min-w-0 items-stretch gap-1">

            <StageCard
              stage={s}
              peak={peak}
              active={activeStage === s.stage}
              onSelect={onSelect}
            />
            {i < stages.length - 1 && (
              <div className="hidden w-6 items-center justify-center @4xl/page:flex">
                <ChevronRight
                  className={cn("h-4 w-4", HEALTH_TEXT[stages[i + 1].health])}
                  aria-hidden
                />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StageCard({
  stage: s, peak, active, onSelect,
}: {
  stage: FlowStageHealth;
  peak: number;
  active?: boolean;
  onSelect?: (stage: FlowStageHealth) => void;
}) {
  const pct = Math.round((s.backlog / peak) * 100);
  const body = (
    <motion.div
      layout
      className={cn(
        "flex h-full w-full flex-col gap-2 @4xl/page:w-[168px] rounded-lg border p-3 text-left transition-colors",
        HEALTH_SURFACE[s.health],
        active && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {s.label}
        </p>
        <span className={cn("text-[10px] font-semibold uppercase", HEALTH_TEXT[s.health])}>
          {HEALTH_LABEL[s.health]}
        </span>
      </div>

      <p className="text-2xl font-semibold tabular-nums leading-none">{s.backlog}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", HEALTH_FILL[s.health])}
          style={{ width: `${Math.max(s.backlog > 0 ? 6 : 0, pct)}%` }}
        />
      </div>

      <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground @4xl/page:grid-cols-1">
        <Cell label="Active" value={s.in_progress} />
        <Cell label="Oldest" value={shortAge(s.oldest_age_seconds)} />
        <Cell
          label="Overdue"
          value={s.sla_breached}
          tone={s.sla_breached > 0 ? "text-destructive" : undefined}
        />
        <Cell
          label="Blocked"
          value={s.blocked}
          tone={s.blocked > 0 ? "text-destructive" : undefined}
        />
        <Cell
          label="Unassigned"
          value={s.unassigned}
          tone={s.unassigned > 0 ? "text-warning" : undefined}
        />
        <Cell
          label="At risk"
          value={s.sla_at_risk}
          tone={s.sla_at_risk > 0 ? "text-warning" : undefined}
        />
      </dl>
    </motion.div>
  );

  if (onSelect) {
    return (
      <button type="button" onClick={() => onSelect(s)} className="w-full min-w-0 text-left">
        {body}
      </button>
    );
  }
  return <Link to={s.drill_route} className="w-full min-w-0">{body}</Link>;

}

function Cell({
  label, value, tone,
}: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <dt className="truncate">{label}</dt>
      <dd className={cn("font-medium tabular-nums text-foreground", tone)}>{value}</dd>
    </div>
  );
}
