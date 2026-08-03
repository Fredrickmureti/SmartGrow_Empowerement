/**
 * ReturnsLaneBoard — the returns "tower" view (Returns audit, Phase 4).
 *
 * Operators do not need another table of rows; they need to know where work is
 * stuck. Each lane is derived from header state *plus* line facts (see
 * `returnLane`) so a return sitting in `received` with uncaptured lines reads
 * as "Unloading", not as a green header.
 */
import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
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

const LANE_ACCENT: Record<ReturnLane, string> = {
  expected: "border-l-muted-foreground/40",
  at_dock: "border-l-primary/60",
  unloading: "border-l-primary/60",
  awaiting_inspection: "border-l-warning",
  awaiting_disposition: "border-l-warning",
  awaiting_posting: "border-l-warning",
  awaiting_finance: "border-l-accent",
  blocked: "border-l-destructive",
  closed: "border-l-muted",
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
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      <Card
        role="button"
        tabIndex={0}
        onClick={() => onSelectLane("all")}
        onKeyDown={(e) => e.key === "Enter" && onSelectLane("all")}
        className={cn(
          "cursor-pointer border-l-4 border-l-primary transition-colors hover:bg-muted/40",
          activeLane === "all" && "bg-muted/60 ring-1 ring-ring",
        )}
      >
        <CardContent className="p-3">
          <div className="text-2xl font-semibold tabular-nums">{orders.length}</div>
          <div className="text-xs text-muted-foreground">All open</div>
          <div
            className={cn(
              "mt-1 text-xs tabular-nums",
              totalBreached > 0 ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {totalBreached > 0 ? `${totalBreached} past SLA` : "All within SLA"}
          </div>
        </CardContent>
      </Card>

      {LANE_ORDER.map((lane) => {
        const stat = stats.get(lane) ?? EMPTY;
        return (
          <Card
            key={lane}
            role="button"
            tabIndex={0}
            onClick={() => onSelectLane(lane)}
            onKeyDown={(e) => e.key === "Enter" && onSelectLane(lane)}
            title={`SLA ${RETURN_LANE_SLA_HOURS[lane]}h`}
            className={cn(
              "cursor-pointer border-l-4 transition-colors hover:bg-muted/40",
              LANE_ACCENT[lane],
              activeLane === lane && "bg-muted/60 ring-1 ring-ring",
            )}
          >
            <CardContent className="p-3">
              <div className="text-2xl font-semibold tabular-nums">{stat.count}</div>
              <div className="text-xs text-muted-foreground">{RETURN_LANE_LABEL[lane]}</div>
              <div className="mt-1 flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                <span>oldest {ageLabel(stat.oldestHours)}</span>
                {stat.breached > 0 && (
                  <span className="ml-auto flex items-center gap-0.5 font-medium text-destructive">
                    <AlarmClock className="h-3 w-3" />
                    {stat.breached}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

