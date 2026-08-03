/**
 * Mobile "My work" — the operator's labour surface (WLM Phase F).
 *
 * This screen is the operator half of the Labour Control Centre. It does
 * three things and refuses to do a fourth:
 *   1. Clock — start a shift, take a break, end a shift. Idle and break time
 *      are opened/closed by the database, never by this component.
 *   2. Claim — pull the next task the operator is *eligible* for. Eligibility
 *      (skills, certifications, workload) is decided by `wms_claim_next_task`.
 *   3. See the truth — earned vs. clocked time for the day, including idle.
 *
 * It never writes stock, never edits a task row directly and never computes
 * a standard client-side.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Play,
  Pause,
  LogOut,
  Zap,
  Timer,
  Gauge,
  CheckCircle2,
} from "lucide-react";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWarehouses } from "@/hooks/useWarehouses";
import {
  useMyOperator,
  useMyOpenTasks,
  useMyPerformance,
  useShiftActions,
  type OperatorStatus,
} from "@/features/warehouse/labour/useMyShift";

const TASK_ROUTE: Record<string, (id: string) => string> = {
  putaway: (id) => `/wm/putaway/${id}`,
  pick: (id) => `/wm/pick/${id}`,
  pack: (id) => `/wm/pack/${id}`,
};

const STATUS_LABEL: Record<OperatorStatus, string> = {
  off_shift: "Off shift",
  on_shift: "On shift",
  break: "On break",
  executing: "Working",
};

function hhmm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function MobileMyWork() {
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const [logMinutes, setLogMinutes] = useState("");
  const [logCategory, setLogCategory] = useState<
    "indirect" | "travel" | "training" | "meeting" | "maintenance"
  >("indirect");

  useEffect(() => {
    if (!warehouseId && warehouses.length) setWarehouseId(warehouses[0].id);
  }, [warehouses, warehouseId]);

  const { data: operator, isLoading: loadingOperator } = useMyOperator(warehouseId);
  const { data: tasks } = useMyOpenTasks(warehouseId);
  const { data: performance } = useMyPerformance(warehouseId, 1);
  const { clock, claimNext, logIndirect } = useShiftActions(warehouseId);

  const today = performance?.[0];
  const clocked = useMemo(() => {
    if (!today) return 0;
    return (
      Number(today.direct_seconds ?? 0) +
      Number(today.indirect_seconds ?? 0) +
      Number(today.idle_seconds ?? 0)
    );
  }, [today]);

  const status = (operator?.status ?? "off_shift") as OperatorStatus;
  const onShift = status !== "off_shift";
  const busy = clock.isPending || claimNext.isPending;

  return (
    <MobileWarehouseLayout title="My work">
      <div className="space-y-4">
        <div>
          <Label className="text-xs text-muted-foreground">Warehouse</Label>
          <Select value={warehouseId ?? ""} onValueChange={setWarehouseId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select warehouse" />
            </SelectTrigger>
            <SelectContent>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!loadingOperator && warehouseId && !operator ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              You are not enrolled as an operator in this warehouse. Ask your
              supervisor to add you on the Labour board.
            </CardContent>
          </Card>
        ) : null}

        {operator ? (
          <>
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">
                      {operator.operator_code ?? "Operator"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Max {operator.max_concurrent_tasks} concurrent task
                      {operator.max_concurrent_tasks === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Badge variant={onShift ? "default" : "secondary"}>
                    {STATUS_LABEL[status]}
                  </Badge>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <Button
                    size="sm"
                    variant={status === "on_shift" ? "default" : "outline"}
                    disabled={busy || status === "on_shift" || status === "executing"}
                    onClick={() => clock.mutate({ status: "on_shift" })}
                  >
                    <Play className="mr-1 h-4 w-4" /> Start
                  </Button>
                  <Button
                    size="sm"
                    variant={status === "break" ? "default" : "outline"}
                    disabled={busy || !onShift || status === "break"}
                    onClick={() => clock.mutate({ status: "break" })}
                  >
                    <Pause className="mr-1 h-4 w-4" /> Break
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || status === "off_shift"}
                    onClick={() => clock.mutate({ status: "off_shift" })}
                  >
                    <LogOut className="mr-1 h-4 w-4" /> End
                  </Button>
                </div>

                <Button
                  className="w-full"
                  disabled={busy || !onShift}
                  onClick={() => claimNext.mutate(undefined)}
                >
                  <Zap className="mr-2 h-4 w-4" />
                  {claimNext.isPending ? "Finding work…" : "Claim next task"}
                </Button>
                {!onShift ? (
                  <p className="text-xs text-muted-foreground">
                    Start your shift before claiming work.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="grid grid-cols-3 gap-2 p-4 text-center">
                <div>
                  <CheckCircle2 className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-1 text-lg font-semibold">
                    {today?.tasks_completed ?? 0}
                  </div>
                  <div className="text-[11px] text-muted-foreground">Done today</div>
                </div>
                <div>
                  <Timer className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-1 text-lg font-semibold">{hhmm(clocked)}</div>
                  <div className="text-[11px] text-muted-foreground">Clocked</div>
                </div>
                <div>
                  <Gauge className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-1 text-lg font-semibold">
                    {today?.true_utilisation != null
                      ? `${Math.round(Number(today.true_utilisation) * 100)}%`
                      : "—"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">Performance</div>
                </div>
              </CardContent>
            </Card>

            <section>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                My open tasks · {tasks?.length ?? 0}
              </h2>
              {(tasks ?? []).length === 0 ? (
                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                  Nothing in hand. Claim the next task when you are ready.
                </div>
              ) : (
                <ul className="space-y-2">
                  {tasks!.map((t) => {
                    const to = TASK_ROUTE[t.task_type]?.(t.id);
                    const body = (
                      <div className="flex items-center justify-between rounded border p-3 active:bg-muted">
                        <div>
                          <div className="text-sm font-medium capitalize">
                            {String(t.task_type).replace(/_/g, " ")}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {t.id.slice(0, 8)} · {t.state}
                          </div>
                        </div>
                        {to ? (
                          <span className="text-xs text-muted-foreground">tap →</span>
                        ) : null}
                      </div>
                    );
                    return (
                      <li key={t.id}>{to ? <Link to={to}>{body}</Link> : body}</li>
                    );
                  })}
                </ul>
              )}
            </section>

            <Card>
              <CardContent className="space-y-2 p-4">
                <div className="text-sm font-semibold">Log indirect time</div>
                <p className="text-xs text-muted-foreground">
                  Time spent off-task still belongs to the shift — record it so
                  your performance figure is fair.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={logCategory}
                    onValueChange={(v) => setLogCategory(v as typeof logCategory)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="indirect">Indirect</SelectItem>
                      <SelectItem value="travel">Travel</SelectItem>
                      <SelectItem value="training">Training</SelectItem>
                      <SelectItem value="meeting">Meeting</SelectItem>
                      <SelectItem value="maintenance">Maintenance</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    inputMode="numeric"
                    placeholder="Minutes"
                    value={logMinutes}
                    onChange={(e) => setLogMinutes(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={
                    logIndirect.isPending ||
                    !Number(logMinutes) ||
                    Number(logMinutes) <= 0
                  }
                  onClick={() =>
                    logIndirect.mutate(
                      { category: logCategory, minutes: Number(logMinutes) },
                      { onSuccess: () => setLogMinutes("") },
                    )
                  }
                >
                  Log time
                </Button>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </MobileWarehouseLayout>
  );
}
