/**
 * ReturnsLaneBoard — the returns "tower" view (Returns audit, Phase 4).
 *
 * Operators do not need another table of rows; they need to know where work is
 * stuck. Each lane is derived from header state *plus* line facts (see
 * `returnLane`) so a return sitting in `received` with uncaptured lines reads
 * as "Unloading", not as a green header.
 */
import { useMemo } from "react";
import {
  SummaryStatCard,
  SummaryStatGrid,
  type SummaryStatTone,
} from "@/components/common/SummaryStatCards";
import { cn } from "@/lib/utils";
import { AlarmClock } from "lucide-react";
import {
  RETURN_LANE_LABEL,
  RETURN_LANE_SLA_HOURS,
  laneStats,
  type LaneStat,
  type ReturnLane,
  type ReturnLine,
  type ReturnOrder,
} from "./returnsModel";

const LANE_ORDER: ReturnLane[] = [
  "expected",
  "at_dock",
  "unloading",
  "awaiting_inspection",
  "awaiting_disposition",
  "awaiting_posting",
  "awaiting_finance",
  "blocked",
];

const LANE_TONE: Record<ReturnLane, SummaryStatTone> = {
  expected: "neutral",
  at_dock: "primary",
  unloading: "primary",
  awaiting_inspection: "warn",
  awaiting_disposition: "warn",
  awaiting_posting: "warn",
  awaiting_finance: "purple",
  blocked: "bad",
  closed: "neutral",
};

export interface ReturnsLaneBoardProps {
  orders: ReturnOrder[];
  linesByOrder: Map<string, ReturnLine[]>;
  activeLane: ReturnLane | "all";
  onSelectLane: (lane: ReturnLane | "all") => void;
}

export function laneCounts(
  orders: ReturnOrder[],
  linesByOrder: Map<string, ReturnLine[]>,
): Map<ReturnLane, number> {
  const counts = new Map<ReturnLane, number>();
  for (const [lane, stat] of laneStats(orders, linesByOrder)) counts.set(lane, stat.count);
  return counts;
}

const EMPTY: LaneStat = { count: 0, breached: 0, oldestHours: null };

function ageLabel(hours: number | null): string {
  if (hours == null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ReturnsLaneBoard({
  orders,
  linesByOrder,
  activeLane,
  onSelectLane,
}: ReturnsLaneBoardProps) {
  const stats = useMemo(() => laneStats(orders, linesByOrder), [orders, linesByOrder]);
  const totalBreached = useMemo(
    () => [...stats.values()].reduce((n, s) => n + s.breached, 0),
    [stats],
  );

  return (
    <SummaryStatGrid>
      <SummaryStatCard
        label="All open"
        value={orders.length}
        tone="primary"
        accent
        onClick={() => onSelectLane("all")}
        className={cn(activeLane === "all" && "bg-muted/60 ring-1 ring-ring")}
        footer={
          <span className={cn(totalBreached > 0 && "text-destructive")}>
            {totalBreached > 0 ? `${totalBreached} past SLA` : "All within SLA"}
          </span>
        }
      />

      {LANE_ORDER.map((lane) => {
        const stat = stats.get(lane) ?? EMPTY;
        return (
          <SummaryStatCard
            key={lane}
            label={RETURN_LANE_LABEL[lane]}
            value={stat.count}
            tone={LANE_TONE[lane]}
            accent
            onClick={() => onSelectLane(lane)}
            title={`SLA ${RETURN_LANE_SLA_HOURS[lane]}h`}
            className={cn(activeLane === lane && "bg-muted/60 ring-1 ring-ring")}
            status={
              stat.breached > 0 ? (
                <span className="flex items-center gap-0.5 text-xs font-medium tabular-nums text-destructive">
                  <AlarmClock className="h-3 w-3" />
                  {stat.breached}
                </span>
              ) : undefined
            }
            footer={`oldest ${ageLabel(stat.oldestHours)}`}
          />
        );
      })}
    </SummaryStatGrid>
  );
}


