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
import {
  RETURN_LANE_LABEL,
  returnLane,
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
  for (const order of orders) {
    const lane = returnLane(order, linesByOrder.get(order.id) ?? []);
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  return counts;
}

export function ReturnsLaneBoard({
  orders,
  linesByOrder,
  activeLane,
  onSelectLane,
}: ReturnsLaneBoardProps) {
  const counts = useMemo(() => laneCounts(orders, linesByOrder), [orders, linesByOrder]);

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
        </CardContent>
      </Card>

      {LANE_ORDER.map((lane) => (
        <Card
          key={lane}
          role="button"
          tabIndex={0}
          onClick={() => onSelectLane(lane)}
          onKeyDown={(e) => e.key === "Enter" && onSelectLane(lane)}
          className={cn(
            "cursor-pointer border-l-4 transition-colors hover:bg-muted/40",
            LANE_ACCENT[lane],
            activeLane === lane && "bg-muted/60 ring-1 ring-ring",
          )}
        >
          <CardContent className="p-3">
            <div className="text-2xl font-semibold tabular-nums">{counts.get(lane) ?? 0}</div>
            <div className="text-xs text-muted-foreground">{RETURN_LANE_LABEL[lane]}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
