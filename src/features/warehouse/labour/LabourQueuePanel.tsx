/**
 * LabourQueuePanel — the supervisor's live work queue.
 *
 * The queue is one list across every execution domain, because that is
 * what the task engine actually is. Supervisors act on exceptions:
 * escalate priority, reassign to an eligible operator, or return work
 * to the pool. Eligibility is enforced server-side, so an invalid
 * reassignment fails loudly rather than silently mis-routing work.
 */
import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState } from "@/design-system";
import { ArrowUp, ArrowDown, Undo2 } from "lucide-react";
import { WMS_TASK_TYPES, useOperatorBoard, type WmsTaskType } from "./useLabourOperators";
import { useLabourQueue, useSupervisorActions } from "./useLabourQueue";

interface Props {
  warehouseId: string;
}

export function LabourQueuePanel({ warehouseId }: Props) {
  const [taskType, setTaskType] = useState<WmsTaskType | "all">("all");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);

  const { data: queue, isLoading } = useLabourQueue({ warehouseId, taskType, onlyUnassigned });
  const { data: operators } = useOperatorBoard(warehouseId);
  const { reassign, release, setPriority } = useSupervisorActions();

  const operatorByUser = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of operators ?? []) {
      if (o.user_id) m.set(o.user_id, o.operator_name || o.operator_code || o.user_id.slice(0, 8));
    }
    return m;
  }, [operators]);

  const assignable = (operators ?? []).filter((o) => o.user_id && o.is_active);

  const summary = useMemo(() => {
    const rows = queue ?? [];
    let breached = 0, unassigned = 0;
    for (const r of rows) {
      if (r.sla_breached) breached += 1;
      if (!r.assignee_user_id) unassigned += 1;
    }
    return { total: rows.length, breached, unassigned };
  }, [queue]);

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="w-52">
          <Label>Task type</Label>
          <Select value={taskType} onValueChange={(v) => setTaskType(v as WmsTaskType | "all")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {WMS_TASK_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 h-10">
          <Switch checked={onlyUnassigned} onCheckedChange={setOnlyUnassigned} id="unassigned-only" />
          <Label htmlFor="unassigned-only">Unassigned only</Label>
        </div>
        <div className="flex flex-wrap gap-2 h-10 items-center">
          <Badge variant="secondary">Open: {summary.total}</Badge>
          <Badge variant={summary.breached > 0 ? "destructive" : "secondary"}>
            SLA breached: {summary.breached}
          </Badge>
          <Badge variant="outline">Unassigned: {summary.unassigned}</Badge>
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (queue ?? []).length === 0 ? (
        <EmptyState title="No open tasks" description="The labour queue is clear for these filters." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead className="text-right">Priority</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead className="w-[260px]">Supervisor actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(queue ?? []).map((t) => (
              <TableRow key={t.task_id} className={t.sla_breached ? "bg-destructive/5" : undefined}>
                <TableCell className="font-mono text-xs">{t.task_id.slice(0, 8)}</TableCell>
                <TableCell className="capitalize">{t.task_type}</TableCell>
                <TableCell><Badge variant="outline">{t.state}</Badge></TableCell>
                <TableCell>
                  {t.assignee_user_id
                    ? operatorByUser.get(t.assignee_user_id) ?? t.assignee_user_id.slice(0, 8)
                    : <span className="text-muted-foreground">Unassigned</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{t.priority}</TableCell>
                <TableCell>
                  {t.sla_at ? (
                    <span className={t.sla_breached ? "text-destructive font-medium" : undefined}>
                      {formatDistanceToNow(new Date(t.sla_at), { addSuffix: true })}
                    </span>
                  ) : "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Select
                      value=""
                      onValueChange={(userId) => reassign.mutate({ taskId: t.task_id, userId, rowVersion: t.row_version, reason: "supervisor" })}
                    >
                      <SelectTrigger className="h-8 w-full @xl/page:w-[130px]">
                        <SelectValue placeholder="Assign to…" />
                      </SelectTrigger>
                      <SelectContent>
                        {assignable.length === 0 && (
                          <SelectItem value="__none" disabled>No operators</SelectItem>
                        )}
                        {assignable.map((o) => (
                          <SelectItem key={o.operator_id} value={o.user_id!}>
                            {o.operator_name || o.operator_code} ({o.open_tasks}/{o.max_concurrent_tasks})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon" variant="ghost" title="Raise priority"
                      onClick={() => setPriority.mutate({ taskId: t.task_id, priority: t.priority + 10, rowVersion: t.row_version })}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon" variant="ghost" title="Lower priority"
                      onClick={() => setPriority.mutate({ taskId: t.task_id, priority: Math.max(0, t.priority - 10), rowVersion: t.row_version })}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon" variant="ghost" title="Return to pool"
                      disabled={!t.assignee_user_id}
                      onClick={() => release.mutate({ taskId: t.task_id, rowVersion: t.row_version, reason: "supervisor release" })}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
