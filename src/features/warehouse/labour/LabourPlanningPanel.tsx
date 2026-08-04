/**
 * LabourPlanningPanel — supply vs. demand for the planning horizon.
 *
 * Demand is projected server-side from open tasks through the engineered
 * standards resolver; supply is the roster. The gap column is the whole
 * point of the screen: a supervisor should see a short day before it
 * happens, not after the SLA is missed. Publishing the roster raises
 * `warehouse.labour.gap_detected` on the warehouse outbox so the same
 * shortfall reaches notifications and downstream planning consumers.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LabourRosterButton } from "./LabourRosterButton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState } from "@/design-system";
import { AlertTriangle, CalendarRange, Plus, Send, X } from "lucide-react";
import { useOperatorBoard } from "./useLabourOperators";
import {
  DAY_LABELS,
  isoDay,
  useApplyRosterPattern,
  useCancelOperatorShift,
  useLabourDemand,
  useLabourPlan,
  useOperatorShifts,
  usePublishLabourPlan,
  useShiftPatterns,
  useUpsertShiftPattern,
  type ShiftPattern,
} from "./useLabourPlanning";

interface Props {
  /** "all" or a warehouse id — mirrors the board-level filter. */
  warehouseId: string;
  warehouses: Array<{ id: string; name: string }>;
}

const HORIZONS = [7, 14, 28] as const;

function hrs(seconds: number | null | undefined): string {
  const s = Number(seconds ?? 0);
  return `${(s / 3600).toFixed(1)}h`;
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const EMPTY_PATTERN = {
  warehouse_id: "",
  code: "",
  name: "",
  start_time: "08:00",
  end_time: "17:00",
  days_of_week: [1, 2, 3, 4, 5],
  break_minutes: 30,
  is_active: true,
};

export function LabourPlanningPanel({ warehouseId, warehouses }: Props) {
  const [horizon, setHorizon] = useState<number>(7);
  const from = isoDay(0);
  const to = isoDay(horizon - 1);

  const scoped = warehouseId !== "all" ? warehouseId : undefined;

  const { data: plan, isLoading: planLoading } = useLabourPlan(warehouseId, from, to);
  const { data: demand } = useLabourDemand(warehouseId, from, to);
  const { data: patterns } = useShiftPatterns(warehouseId);
  const { data: shifts } = useOperatorShifts(warehouseId, from, to);
  const { data: operators } = useOperatorBoard(warehouseId);

  const upsertPattern = useUpsertShiftPattern();
  const applyPattern = useApplyRosterPattern();
  const publishPlan = usePublishLabourPlan();
  const cancelShift = useCancelOperatorShift();

  const [patternOpen, setPatternOpen] = useState(false);
  const [patternForm, setPatternForm] = useState({ ...EMPTY_PATTERN });
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rosterPatternId, setRosterPatternId] = useState<string>("");
  const [rosterOperators, setRosterOperators] = useState<string[]>([]);

  const totals = useMemo(() => {
    return (plan ?? []).reduce(
      (acc, r) => ({
        required: acc.required + Number(r.required_seconds ?? 0),
        planned: acc.planned + Number(r.planned_seconds ?? 0),
        gapDays: acc.gapDays + (Number(r.gap_seconds ?? 0) > 0 ? 1 : 0),
        overdue: acc.overdue + Number(r.overdue_tasks ?? 0),
      }),
      { required: 0, planned: 0, gapDays: 0, overdue: 0 },
    );
  }, [plan]);

  const unstandardised = useMemo(
    () => (demand ?? []).reduce((n, r) => n + Number(r.unstandardised ?? 0), 0),
    [demand],
  );

  const activePatterns = (patterns ?? []).filter((p) => p.is_active);
  const openPatternDialog = () => {
    setPatternForm({ ...EMPTY_PATTERN, warehouse_id: scoped ?? warehouses[0]?.id ?? "" });
    setPatternOpen(true);
  };

  const toggleDay = (day: number) =>
    setPatternForm((f) => ({
      ...f,
      days_of_week: f.days_of_week.includes(day)
        ? f.days_of_week.filter((d) => d !== day)
        : [...f.days_of_week, day].sort(),
    }));

  const toggleOperator = (id: string) =>
    setRosterOperators((ops) => (ops.includes(id) ? ops.filter((o) => o !== id) : [...ops, id]));

  const rosterPattern: ShiftPattern | undefined = activePatterns.find(
    (p) => p.id === rosterPatternId,
  );
  const eligibleOperators = (operators ?? []).filter(
    (o) => o.is_active && (!rosterPattern || o.warehouse_id === rosterPattern.warehouse_id),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">Planning horizon</Label>
          <Select value={String(horizon)} onValueChange={(v) => setHorizon(Number(v))}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HORIZONS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  Next {h} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={openPatternDialog}>
            <Plus className="h-4 w-4 mr-2" /> Shift pattern
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setRosterPatternId(activePatterns[0]?.id ?? "");
              setRosterOperators([]);
              setRosterOpen(true);
            }}
            disabled={activePatterns.length === 0}
          >
            <CalendarRange className="h-4 w-4 mr-2" /> Roll out roster
          </Button>
          <LabourRosterButton warehouseId={scoped} />

          <Button
            onClick={() =>
              scoped && publishPlan.mutate({ warehouseId: scoped, from, to })
            }
            disabled={!scoped || publishPlan.isPending}
            title={scoped ? undefined : "Select a single warehouse to publish its roster"}
          >
            <Send className="h-4 w-4 mr-2" /> Publish plan
          </Button>
        </div>
      </div>

      <div className="grid gap-4 @2xl/page:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm text-muted-foreground">Required</div>
            <div className="text-2xl font-semibold mt-1">{hrs(totals.required)}</div>
            <p className="text-xs text-muted-foreground">Standard hours for open work</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm text-muted-foreground">Planned</div>
            <div className="text-2xl font-semibold mt-1">{hrs(totals.planned)}</div>
            <p className="text-xs text-muted-foreground">Rostered operator hours</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm text-muted-foreground">Short days</div>
            <div className="text-2xl font-semibold mt-1">{totals.gapDays}</div>
            <p className="text-xs text-muted-foreground">Days demand exceeds roster</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm text-muted-foreground">Overdue tasks</div>
            <div className="text-2xl font-semibold mt-1">{totals.overdue}</div>
            <p className="text-xs text-muted-foreground">Already past SLA</p>
          </CardContent>
        </Card>
      </div>

      {unstandardised > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-warning" />
          <span>
            {unstandardised} open task{unstandardised === 1 ? "" : "s"} have no engineered
            standard, so the demand figure understates the real workload. Add standards on the
            Standards tab to close the blind spot.
          </span>
        </div>
      )}

      {planLoading ? (
        <LoadingState />
      ) : (plan ?? []).length === 0 ? (
        <EmptyState
          title="Nothing to plan yet"
          description="Once tasks exist and operators are rostered, the daily supply and demand picture appears here."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Required</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Operators</TableHead>
              <TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Gap</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(plan ?? []).map((r) => {
              const gap = Number(r.gap_seconds ?? 0);
              return (
                <TableRow key={`${r.plan_date}-${r.warehouse_id}`}>
                  <TableCell>
                    <div className="font-medium">{dayLabel(r.plan_date)}</div>
                    {warehouseId === "all" && (
                      <div className="text-xs text-muted-foreground">
                        {warehouses.find((w) => w.id === r.warehouse_id)?.name ?? "—"}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{hrs(r.required_seconds)}</TableCell>
                  <TableCell className="text-right">
                    {hrs(r.planned_seconds)}
                    {Number(r.published_seconds ?? 0) < Number(r.planned_seconds ?? 0) && (
                      <Badge variant="outline" className="ml-2">draft</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{hrs(r.actual_seconds)}</TableCell>
                  <TableCell className="text-right">{r.planned_operators}</TableCell>
                  <TableCell className="text-right">
                    {r.open_tasks}
                    {Number(r.overdue_tasks ?? 0) > 0 && (
                      <Badge variant="destructive" className="ml-2">
                        {r.overdue_tasks} late
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {gap > 0 ? (
                      <Badge variant="destructive">short {hrs(gap)}</Badge>
                    ) : (
                      <Badge variant="secondary">covered</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div>
        <h4 className="text-sm font-medium mb-2">Rostered shifts in this window</h4>
        {(shifts ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No shifts rostered. Create a shift pattern and roll it out to operators.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Times</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(shifts ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{dayLabel(s.shift_date)}</TableCell>
                  <TableCell>
                    {(operators ?? []).find((o) => o.operator_id === s.operator_id)
                      ?.operator_name ?? "—"}
                  </TableCell>
                  <TableCell>
                    {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                    {s.break_minutes > 0 && (
                      <span className="text-muted-foreground"> · {s.break_minutes}m break</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === "published" ? "default" : "outline"}>
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {s.status !== "cancelled" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => cancelShift.mutate(s.id)}
                        aria-label="Cancel shift"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={patternOpen} onOpenChange={setPatternOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Shift pattern</DialogTitle>
            <DialogDescription>
              A repeatable shift template. Rolling it out creates dated shifts for the operators
              you choose.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Warehouse</Label>
              <Select
                value={patternForm.warehouse_id}
                onValueChange={(v) => setPatternForm((f) => ({ ...f, warehouse_id: v }))}
              >
                <SelectTrigger>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Code</Label>
                <Input
                  value={patternForm.code}
                  onChange={(e) => setPatternForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="DAY"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input
                  value={patternForm.name}
                  onChange={(e) => setPatternForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Day shift"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>Start</Label>
                <Input
                  type="time"
                  value={patternForm.start_time}
                  onChange={(e) => setPatternForm((f) => ({ ...f, start_time: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>End</Label>
                <Input
                  type="time"
                  value={patternForm.end_time}
                  onChange={(e) => setPatternForm((f) => ({ ...f, end_time: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Break (min)</Label>
                <Input
                  type="number"
                  min={0}
                  value={patternForm.break_minutes}
                  onChange={(e) =>
                    setPatternForm((f) => ({ ...f, break_minutes: Number(e.target.value) }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Days</Label>
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={patternForm.days_of_week.includes(d) ? "default" : "outline"}
                    onClick={() => toggleDay(d)}
                  >
                    {DAY_LABELS[d]}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="pattern-active">Active</Label>
              <Switch
                id="pattern-active"
                checked={patternForm.is_active}
                onCheckedChange={(v) => setPatternForm((f) => ({ ...f, is_active: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPatternOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                upsertPattern.mutate(patternForm, { onSuccess: () => setPatternOpen(false) })
              }
              disabled={
                upsertPattern.isPending ||
                !patternForm.warehouse_id ||
                !patternForm.code.trim() ||
                !patternForm.name.trim() ||
                patternForm.days_of_week.length === 0
              }
            >
              Save pattern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rosterOpen} onOpenChange={setRosterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Roll out roster</DialogTitle>
            <DialogDescription>
              Creates shifts for the selected operators across the planning horizon. Re-running is
              safe — existing shifts are left untouched.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Pattern</Label>
              <Select value={rosterPatternId} onValueChange={setRosterPatternId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select pattern" />
                </SelectTrigger>
                <SelectContent>
                  {activePatterns.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.code} · {p.start_time.slice(0, 5)}–{p.end_time.slice(0, 5)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Operators</Label>
              <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                {eligibleOperators.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-2">
                    No active operators in this warehouse.
                  </p>
                ) : (
                  eligibleOperators.map((o) => (
                    <label
                      key={o.operator_id}
                      className="flex items-center justify-between py-1.5 text-sm cursor-pointer"
                    >
                      <span>{o.operator_name ?? o.operator_code ?? o.operator_id}</span>
                      <Switch
                        checked={rosterOperators.includes(o.operator_id)}
                        onCheckedChange={() => toggleOperator(o.operator_id)}
                      />
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {dayLabel(from)} – {dayLabel(to)}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRosterOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                applyPattern.mutate(
                  {
                    patternId: rosterPatternId,
                    operatorIds: rosterOperators,
                    from,
                    to,
                  },
                  { onSuccess: () => setRosterOpen(false) },
                )
              }
              disabled={applyPattern.isPending || !rosterPatternId || rosterOperators.length === 0}
            >
              Create shifts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
