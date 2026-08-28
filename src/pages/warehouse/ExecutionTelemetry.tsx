/**
 * Execution Telemetry — Phase 7 of the Operator Task Execution Engine.
 *
 * Derived entirely from the `wms_task_events` ledger via
 * `wms_task_telemetry`. No new counters, no denormalised columns: if the
 * ledger did not record it, it is not shown.
 */
import {
  SummaryStatCard,
  SummaryStatGrid,
} from "@/components/common/SummaryStatCards";
import { useMemo, useState } from "react";
import { Activity, Gauge, Timer, TriangleAlert } from "lucide-react";

import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  ErrorState,
} from "@/design-system";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWarehouses } from "@/hooks/useWarehouses";
import {
  useTaskTelemetry,
  formatDuration,
} from "@/features/warehouse/telemetry/useTaskTelemetry";

const WINDOWS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

function pct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${(Number(v) * 100).toFixed(1)}%`;
}

export default function ExecutionTelemetry() {
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [days, setDays] = useState<string>("7");

  const activeWarehouse = warehouseId || warehouses?.[0]?.id || "";
  const { data, isLoading, error } = useTaskTelemetry(
    activeWarehouse || undefined,
    Number(days),
  );

  const totals = data?.totals;
  const cards = useMemo(
    () => [
      { icon: Activity, label: "Tasks touched", value: totals?.tasks_touched ?? 0 },
      { icon: Gauge, label: "Completed", value: totals?.completed ?? 0 },
      { icon: TriangleAlert, label: "Exceptions", value: totals?.exceptions ?? 0 },
      { icon: Timer, label: "Active operators", value: totals?.active_operators ?? 0 },
    ],
    [totals],
  );

  return (
    <>
      <PageHeader
        title="Operations performance"
        description="Throughput, dwell time, exception and lease-loss rates derived from the append-only task execution ledger."
      />
      <PageBody>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-64 space-y-1">
            <Label>Warehouse</Label>
            <Select value={activeWarehouse} onValueChange={setWarehouseId}>
              <SelectTrigger>
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                {(warehouses ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-48 space-y-1">
            <Label>Window</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!activeWarehouse ? (
          <EmptyState
            icon={Gauge}
            title="No warehouse selected"
            description="Pick a warehouse to see its execution telemetry."
          />
        ) : isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState
            title="Unable to load telemetry"
            description={(error as Error).message}
          />
        ) : (
          <>
            <SummaryStatGrid>
              {cards.map((c) => (
                <SummaryStatCard
                  key={c.label}
                  icon={<c.icon className="h-3.5 w-3.5" />}
                  label={c.label}
                  value={c.value}
                />
              ))}
            </div>

            <Section
              title="By task type"
              description="Wait = ledger first-seen to claim. Execution = start to completion. Reap rate is work recovered from a lost lease."
             contentClassName="px-0 pb-0">
              {(data?.by_type ?? []).length === 0 ? (
                <EmptyState
                  icon={Activity}
                  title="No execution events in this window"
                  description="Telemetry appears as operators claim and complete work."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Tasks</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">Avg wait</TableHead>
                      <TableHead className="text-right">Avg execution</TableHead>
                      <TableHead className="text-right">Exception rate</TableHead>
                      <TableHead className="text-right">Reap rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data!.by_type.map((r) => (
                      <TableRow key={r.task_type}>
                        <TableCell className="font-medium">{r.task_type}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.tasks}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.completed}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDuration(r.avg_wait_seconds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDuration(r.avg_execution_seconds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pct(r.exception_rate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pct(r.reap_rate)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>

            <Section
              title="By operator"
              description="Completions attributed to the actor recorded on the completion event."
             contentClassName="px-0 pb-0">
              {(data?.by_operator ?? []).length === 0 ? (
                <EmptyState
                  icon={Timer}
                  title="No completions recorded"
                  description="Operator throughput appears once tasks are completed in this window."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operator</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">Avg execution</TableHead>
                      <TableHead className="text-right">Exceptions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data!.by_operator.map((o) => (
                      <TableRow key={o.operator_id}>
                        <TableCell className="font-mono text-xs">
                          {o.operator_id.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.completed}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDuration(o.avg_execution_seconds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.exceptions}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}
