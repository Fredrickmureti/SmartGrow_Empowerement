/**
 * Labour Control Centre — Enterprise WLM surface.
 *
 * Warehouse Labour Management is a resource-management discipline, not a
 * report. This page therefore has three working surfaces, not charts:
 *
 *  - Control centre: the live cross-domain task queue with supervisor
 *    intervention (reassign, escalate, release). Every action is an RPC
 *    so eligibility and the state machine stay server-enforced (ADR 0101).
 *  - Operators: the roster of warehouse operators with skills,
 *    certifications, equipment and live availability. This is what makes
 *    assignment capability-aware rather than a raw UUID drop.
 *  - Standards: dimensioned engineered standards (setup + handle +
 *    travel, by warehouse / zone / category / equipment) which produce
 *    earned hours.
 *
 * Performance shows true utilisation — earned hours against direct,
 * indirect AND idle time — because measuring only direct time flatters
 * the number and hides the real labour cost.
 */
import { useMemo, useState } from "react";
import {
  PageHeader, PageBody, Section, LoadingState,
} from "@/design-system";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/design-system";
import { Gauge, Users, ListChecks, Timer } from "lucide-react";
import { useWarehouses } from "@/hooks/useWarehouses";
import { OperatorBoard } from "@/features/warehouse/labour/OperatorBoard";
import { LabourQueuePanel } from "@/features/warehouse/labour/LabourQueuePanel";
import { StandardsPanel } from "@/features/warehouse/labour/StandardsPanel";
import { useUtilisation } from "@/features/warehouse/labour/useLabourQueue";
import { useOperatorBoard } from "@/features/warehouse/labour/useLabourOperators";
import { LabourPlanningPanel } from "@/features/warehouse/labour/LabourPlanningPanel";
import { LabourPerformancePanel } from "@/features/warehouse/labour/LabourPerformancePanel";


function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtHours(seconds: number): string {
  if (!seconds) return "0h";
  const h = seconds / 3600;
  return h >= 10 ? `${h.toFixed(1)}h` : `${h.toFixed(2)}h`;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export default function LabourBoard() {
  const { warehouses } = useWarehouses();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [rangeDays, setRangeDays] = useState<number>(7);

  const since = useMemo(() => daysAgo(rangeDays), [rangeDays]);
  const { data: utilisation, isLoading: utilLoading } = useUtilisation(warehouseFilter, since);
  const { data: operators } = useOperatorBoard(warehouseFilter);

  const nameByUser = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of operators ?? []) {
      if (o.user_id) m.set(o.user_id, o.operator_name || o.operator_code || o.user_id.slice(0, 8));
    }
    return m;
  }, [operators]);

  const byOperator = useMemo(() => {
    const map = new Map<string, {
      earned: number; direct: number; indirect: number; idle: number; travel: number; tasks: number;
    }>();
    for (const r of utilisation ?? []) {
      const acc = map.get(r.user_id) ?? { earned: 0, direct: 0, indirect: 0, idle: 0, travel: 0, tasks: 0 };
      acc.earned += Number(r.earned_seconds) || 0;
      acc.direct += Number(r.direct_seconds) || 0;
      acc.indirect += Number(r.indirect_seconds) || 0;
      acc.idle += Number(r.idle_seconds) || 0;
      acc.travel += Number(r.travel_seconds) || 0;
      acc.tasks += Number(r.tasks_completed) || 0;
      map.set(r.user_id, acc);
    }
    return Array.from(map.entries())
      .map(([user_id, v]) => {
        const paid = v.direct + v.indirect + v.idle;
        return {
          user_id,
          ...v,
          paid,
          trueUtil: paid > 0 ? v.earned / paid : null,
          directUtil: v.direct > 0 ? v.earned / v.direct : null,
        };
      })
      .sort((a, b) => (b.trueUtil ?? -1) - (a.trueUtil ?? -1));
  }, [utilisation]);

  const totals = useMemo(
    () =>
      byOperator.reduce(
        (acc, r) => {
          acc.earned += r.earned;
          acc.paid += r.paid;
          acc.idle += r.idle;
          acc.tasks += r.tasks;
          return acc;
        },
        { earned: 0, paid: 0, idle: 0, tasks: 0 },
      ),
    [byOperator],
  );

  const onShift = (operators ?? []).filter((o) => o.status === "on_shift" || o.status === "executing").length;

  return (
    <>
      <PageHeader
        title="Labour control centre"
        description="Operators, capability-aware assignment, engineered standards and true utilisation."
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="w-56">
            <Label>Warehouse</Label>
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {(warehouses ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <Label>Range</Label>
            <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Today</SelectItem>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Users className="h-4 w-4" /> Operators on shift
              </div>
              <div className="text-2xl font-semibold mt-1">
                {onShift}/{(operators ?? []).length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Gauge className="h-4 w-4" /> True utilisation
              </div>
              <div className="text-2xl font-semibold mt-1">
                {pct(totals.paid > 0 ? totals.earned / totals.paid : null)}
              </div>
              <p className="text-xs text-muted-foreground">Earned ÷ (direct + indirect + idle)</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Timer className="h-4 w-4" /> Idle time
              </div>
              <div className="text-2xl font-semibold mt-1">{fmtHours(totals.idle)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <ListChecks className="h-4 w-4" /> Tasks completed
              </div>
              <div className="text-2xl font-semibold mt-1">{totals.tasks}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="queue">
          <TabsList>
            <TabsTrigger value="queue">Control centre</TabsTrigger>
            <TabsTrigger value="operators">Operators</TabsTrigger>
            <TabsTrigger value="planning">Planning</TabsTrigger>
            <TabsTrigger value="standards">Standards</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="targets">Targets &amp; coaching</TabsTrigger>
          </TabsList>

          <TabsContent value="planning" className="mt-4">
            <Section
              title="Labour planning"
              description="Projected standard hours for open work against the rostered operator hours, day by day. Publishing raises a gap alert when demand outruns capacity."
            >
              <LabourPlanningPanel warehouseId={warehouseFilter} warehouses={warehouses ?? []} />
            </Section>
          </TabsContent>


          <TabsContent value="queue" className="mt-4">
            <Section
              title="Live labour queue"
              description="Every open task across pick, pack, putaway, replenish, count, QC, move and load — one engine, one queue."
            >
              <LabourQueuePanel warehouseId={warehouseFilter} />
            </Section>
          </TabsContent>

          <TabsContent value="operators" className="mt-4">
            <Section
              title="Operator roster"
              description="Skills, certifications, equipment and live availability. Eligibility is enforced when tasks are claimed or assigned."
            >
              <OperatorBoard warehouseId={warehouseFilter} warehouses={warehouses ?? []} />
            </Section>
          </TabsContent>

          <TabsContent value="standards" className="mt-4">
            <Section
              title="Engineered standards"
              description="Setup, handling and travel time by warehouse, zone, product category and equipment class."
            >
              <StandardsPanel warehouses={warehouses ?? []} />
            </Section>
          </TabsContent>

          <TabsContent value="performance" className="mt-4">
            <Section
              title="Operator performance"
              description="Earned hours against all paid time — direct execution, indirect work and idle."
            >
              {utilLoading ? (
                <LoadingState />
              ) : byOperator.length === 0 ? (
                <EmptyState
                  title="No labour recorded"
                  description="Complete tasks with active standards in place to start earning hours."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Operator</TableHead>
                      <TableHead className="text-right">Tasks</TableHead>
                      <TableHead className="text-right">Earned</TableHead>
                      <TableHead className="text-right">Direct</TableHead>
                      <TableHead className="text-right">Indirect</TableHead>
                      <TableHead className="text-right">Idle</TableHead>
                      <TableHead className="text-right">Travel</TableHead>
                      <TableHead className="text-right">Direct util.</TableHead>
                      <TableHead className="text-right">True util.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byOperator.map((r) => (
                      <TableRow key={r.user_id}>
                        <TableCell className="font-medium">
                          {nameByUser.get(r.user_id) ?? r.user_id.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.tasks}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtHours(r.earned)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtHours(r.direct)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtHours(r.indirect)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtHours(r.idle)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtHours(r.travel)}</TableCell>
                        <TableCell className="text-right tabular-nums">{pct(r.directUtil)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{pct(r.trueUtil)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="targets" className="mt-4">
            <Section
              title="Targets & coaching"
              description="Goals resolved most-specific-wins, measured against earned hours, with coaching written to the employee record."
            >
              <LabourPerformancePanel warehouseId={warehouseFilter} warehouses={warehouses ?? []} />
            </Section>
          </TabsContent>
        </Tabs>

      </PageBody>
    </>
  );
}
