/**
 * Live work panel — the work list a supervisor actually acts on.
 *
 * Rows come from `wms_labour_queue_view` (already SLA/priority ordered by
 * the server) and are then grouped into risk buckets for display so the
 * overdue and blocked work sits at the top regardless of type. Every action
 * dispatches an existing sanctioned RPC through `useSupervisorActions` —
 * the client never writes `wms_tasks` directly.
 */
import { useMemo, useState } from "react";
import { MoreHorizontal, UserPlus, Undo2, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState } from "@/design-system";
import { useLabourQueue, useSupervisorActions } from "@/features/warehouse/labour/useLabourQueue";
import { useOperatorBoard } from "@/features/warehouse/labour/useLabourOperators";
import {
  HEALTH_TEXT, RISK_LABEL, RISK_ORDER, RISK_TONE, humanise, riskBucket, shortAge,
  type RiskBucket,
} from "./contract";

interface Props {
  warehouseId?: string;
  /** Optional stage filter driven by clicking the flow spine. */
  taskTypes?: readonly string[] | null;
  limit?: number;
}

export function LiveWorkPanel({ warehouseId, taskTypes, limit = 25 }: Props) {
  const { data: rows, isLoading } = useLabourQueue({ warehouseId, taskType: "all" });
  const { data: operators } = useOperatorBoard(warehouseId);
  const { reassign, release, setPriority } = useSupervisorActions();
  const [riskFilter, setRiskFilter] = useState<RiskBucket | "all">("all");

  const operatorName = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of operators ?? []) {
      if (o.user_id) map.set(o.user_id, o.operator_name ?? o.operator_code ?? "Operator");
    }
    return map;
  }, [operators]);

  const assignable = (operators ?? []).filter(
    (o) => o.is_active && o.user_id && o.status !== "off_shift",
  );

  const ranked = useMemo(() => {
    const scored = (rows ?? [])
      .filter((r) => !taskTypes || taskTypes.includes(r.task_type))
      .map((r) => ({ row: r, bucket: riskBucket(r) }));
    return scored.sort(
      (a, b) =>
        RISK_ORDER.indexOf(a.bucket) - RISK_ORDER.indexOf(b.bucket) ||
        b.row.priority - a.row.priority,
    );
  }, [rows, taskTypes]);

  const counts = useMemo(() => {
    const c = new Map<RiskBucket, number>();
    for (const r of ranked) c.set(r.bucket, (c.get(r.bucket) ?? 0) + 1);
    return c;
  }, [ranked]);

  const visible = ranked
    .filter((r) => riskFilter === "all" || r.bucket === riskFilter)
    .slice(0, limit);

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          active={riskFilter === "all"}
          onClick={() => setRiskFilter("all")}
          label="All"
          count={ranked.length}
        />
        {RISK_ORDER.filter((b) => (counts.get(b) ?? 0) > 0).map((b) => (
          <FilterChip
            key={b}
            active={riskFilter === b}
            onClick={() => setRiskFilter(b)}
            label={RISK_LABEL[b]}
            count={counts.get(b) ?? 0}
            tone={HEALTH_TEXT[RISK_TONE[b]]}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No open work" description="Nothing is queued for this scope." />
      ) : (
        <>
        {/* Mobile: card rows — a table cannot fit a phone without scrolling. */}
        <ul className="divide-y rounded-lg border @2xl/page:hidden">
          {visible.map(({ row, bucket }) => (
            <li key={row.task_id} className="flex items-start gap-2 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={cn(
                      "text-[11px] font-semibold uppercase",
                      HEALTH_TEXT[RISK_TONE[bucket]],
                    )}
                  >
                    {RISK_LABEL[bucket]}
                  </span>
                  <span className="truncate text-sm font-medium capitalize">
                    {humanise(row.task_type)}
                  </span>
                </div>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {humanise(row.state)}
                  {row.source_doc_type ? ` · ${humanise(row.source_doc_type)}` : ""}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="truncate">
                    {row.assignee_user_id
                      ? operatorName.get(row.assignee_user_id) ?? "Assigned"
                      : "Unassigned"}
                  </span>
                  <span className="tabular-nums">
                    {shortAge(
                      row.created_at
                        ? (Date.now() - new Date(row.created_at).getTime()) / 1000
                        : null,
                    )}
                  </span>
                  <span className="tabular-nums">P{row.priority}</span>
                </p>
              </div>
              <RowActions
                row={row}
                assignable={assignable}
                onEscalate={() =>
                  setPriority.mutate({
                    taskId: row.task_id,
                    priority: Math.min(100, row.priority + 20),
                    rowVersion: row.row_version,
                  })
                }
                onRelease={() => release.mutate({ taskId: row.task_id, rowVersion: row.row_version, reason: "supervisor" })}
                onAssign={(userId) =>
                  reassign.mutate({ taskId: row.task_id, userId, rowVersion: row.row_version, reason: "supervisor" })
                }
              />
            </li>
          ))}
        </ul>
        <div className="hidden rounded-lg border @2xl/page:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Risk</TableHead>
                <TableHead>Work</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead className="text-right">Priority</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ row, bucket }) => (
                <TableRow key={row.task_id}>
                  <TableCell>
                    <span
                      className={cn(
                        "text-xs font-semibold uppercase",
                        HEALTH_TEXT[RISK_TONE[bucket]],
                      )}
                    >
                      {RISK_LABEL[bucket]}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm font-medium capitalize">
                      {humanise(row.task_type)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {humanise(row.state)}
                      {row.source_doc_type ? ` · ${humanise(row.source_doc_type)}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.assignee_user_id ? (
                      operatorName.get(row.assignee_user_id) ?? "Assigned"
                    ) : (
                      <Badge variant="outline">Unassigned</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {shortAge(
                      row.created_at
                        ? (Date.now() - new Date(row.created_at).getTime()) / 1000
                        : null,
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {row.priority}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      row={row}
                      assignable={assignable}
                      onEscalate={() =>
                        setPriority.mutate({
                          taskId: row.task_id,
                          priority: Math.min(100, row.priority + 20),
                          rowVersion: row.row_version,
                        })
                      }
                      onRelease={() =>
                        release.mutate({ taskId: row.task_id, rowVersion: row.row_version, reason: "supervisor" })
                      }
                      onAssign={(userId) =>
                        reassign.mutate({ taskId: row.task_id, userId, rowVersion: row.row_version, reason: "supervisor" })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        </>
      )}
    </div>
  );
}

/** Supervisor actions for one queued task — shared by the mobile list and the table. */
function RowActions({
  row, assignable, onEscalate, onRelease, onAssign,
}: {
  row: { task_id: string; assignee_user_id?: string | null };
  assignable: { operator_id: string; user_id: string | null; operator_name: string | null; operator_code: string | null; open_tasks: number }[];
  onEscalate: () => void;
  onRelease: () => void;
  onAssign: (userId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Task actions" className="shrink-0">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={onEscalate}>
          <ArrowUp className="mr-2 h-4 w-4" /> Escalate priority
        </DropdownMenuItem>
        {row.assignee_user_id && (
          <DropdownMenuItem onClick={onRelease}>
            <Undo2 className="mr-2 h-4 w-4" /> Return to pool
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">Assign to</DropdownMenuLabel>
        {assignable.length === 0 && (
          <DropdownMenuItem disabled>No operator on shift</DropdownMenuItem>
        )}
        {assignable.slice(0, 8).map((o) => (
          <DropdownMenuItem key={o.operator_id} onClick={() => onAssign(o.user_id!)}>
            <UserPlus className="mr-2 h-4 w-4" />
            <span className="truncate">
              {o.operator_name ?? o.operator_code ?? "Operator"}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">{o.open_tasks}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterChip({
  active, onClick, label, count, tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active ? "border-primary bg-primary/10 text-foreground" : "hover:bg-muted",
      )}
    >
      <span className={cn(!active && tone)}>{label}</span>
      <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}
