/**
 * Labour capacity panel — who is on the floor and how loaded they are.
 *
 * Projection of `wms_operator_board_view`; performance is earned vs actual
 * seconds stamped server-side. The panel answers the supervisor's second
 * question after "where is the bottleneck?": "do I have the labour to clear
 * it, and who is free?"
 */
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/design-system";
import {
  OPERATOR_STATUS_LABELS, useOperatorBoard,
} from "@/features/warehouse/labour/useLabourOperators";

export function LabourPanel({ warehouseId, limit = 10 }: { warehouseId?: string; limit?: number }) {
  const { data: operators } = useOperatorBoard(warehouseId);
  const rows = (operators ?? []).filter((o) => o.is_active);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No operators"
        description="No active operator is rostered for this warehouse."
      />
    );
  }

  const onShift = rows.filter((o) => o.status !== "off_shift");
  const idle = onShift.filter((o) => o.open_tasks === 0);
  const capacity = onShift.reduce((n, o) => n + o.max_concurrent_tasks, 0);
  const load = onShift.reduce((n, o) => n + o.open_tasks, 0);

  const ordered = [...onShift].sort((a, b) => b.open_tasks - a.open_tasks);

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">On shift</dt>
          <dd className="text-lg font-semibold tabular-nums">{onShift.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Idle</dt>
          <dd
            className={cn(
              "text-lg font-semibold tabular-nums",
              idle.length > 0 && "text-warning",
            )}
          >
            {idle.length}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Load</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {load}
            <span className="text-xs font-normal text-muted-foreground">/{capacity}</span>
          </dd>
        </div>
      </dl>

      <ul className="divide-y rounded-lg border">
        {ordered.slice(0, limit).map((o) => {
          const perf =
            o.actual_seconds_today > 0
              ? Math.round((o.earned_seconds_today / o.actual_seconds_today) * 100)
              : null;
          return (
            <li key={o.operator_id} className="flex items-center gap-3 p-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">
                {o.operator_name ?? o.operator_code ?? "Operator"}
              </span>
              <Badge variant="outline" className="shrink-0">
                {OPERATOR_STATUS_LABELS[o.status]}
              </Badge>
              <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                {o.open_tasks} open
              </span>
              <span
                className={cn(
                  "w-14 shrink-0 text-right tabular-nums",
                  perf !== null && perf < 80 ? "text-warning" : "text-muted-foreground",
                )}
              >
                {perf !== null ? `${perf}%` : "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
