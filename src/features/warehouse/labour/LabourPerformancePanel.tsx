/**
 * LabourPerformancePanel — targets, scorecards and coaching (WLM Phase H).
 *
 * Performance is measured against a target resolved server-side
 * (business → warehouse → task type → operator, most specific wins), never
 * against a number typed into the browser. Every figure on this panel comes
 * from `wms_operator_scorecard`; coaching writes into the company feedback
 * surface through `wms_log_coaching_note`.
 */
import { useMemo, useState } from "react";
import { MessageSquarePlus, Plus, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  useDeleteLabourTarget, useLabourTargets, useLogCoachingNote,
  useOperatorScorecard, useSaveLabourTarget,
  type LabourTargetUpsert, type ScorecardRow,
} from "./useLabourPerformance";
import { isoDay } from "./useLabourPlanning";
import {
  usePayrollInputCodes, usePostIncentiveInputs, useStagedIncentives,
} from "./useLabourIncentive";
import { WMS_TASK_TYPES, type WmsTaskType } from "./useLabourOperators";

interface Props {
  /** "all" or a warehouse id — mirrors the board-level filter. */
  warehouseId: string;
  warehouses: Array<{ id: string; name: string }>;
}

const WINDOWS = [7, 14, 30] as const;
const ANY = "__any__";

const EMPTY_TARGET: LabourTargetUpsert = {
  warehouse_id: null,
  operator_id: null,
  task_type: null,
  target_performance_pct: 100,
  target_utilisation_pct: 85,
  incentive_threshold_pct: null,
  incentive_rate_per_earned_hour: 0,
  notes: null,
  effective_from: isoDay(0),
  effective_to: null,
  is_active: true,
};

const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;

function VarianceBadge({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  const good = value >= 0;
  return (
    <Badge variant={good ? "default" : "destructive"}>
      {good ? "+" : ""}
      {value}
    </Badge>
  );
}

export function LabourPerformancePanel({ warehouseId, warehouses }: Props) {
  const [days, setDays] = useState<number>(7);
  const from = isoDay(-(days - 1));
  const to = isoDay(0);
  const scoped = warehouseId !== "all" ? warehouseId : undefined;

  const { data: scorecard, isLoading } = useOperatorScorecard(warehouseId, from, to);
  const { data: targets } = useLabourTargets(warehouseId);
  const saveTarget = useSaveLabourTarget();
  const deleteTarget = useDeleteLabourTarget();
  const logNote = useLogCoachingNote();

  const [targetOpen, setTargetOpen] = useState(false);
  const [targetForm, setTargetForm] = useState<LabourTargetUpsert>(EMPTY_TARGET);

  const [coachOpen, setCoachOpen] = useState(false);
  const [coachRow, setCoachRow] = useState<ScorecardRow | null>(null);
  const [coachBody, setCoachBody] = useState("");

  const rows = scorecard ?? [];

  const totals = useMemo(() => {
    const earned = rows.reduce((s, r) => s + Number(r.earned_seconds || 0), 0);
    const direct = rows.reduce((s, r) => s + Number(r.direct_seconds || 0), 0);
    const idle = rows.reduce((s, r) => s + Number(r.idle_seconds || 0), 0);
    const indirect = rows.reduce((s, r) => s + Number(r.indirect_seconds || 0), 0);
    const paid = direct + indirect + idle;
    return {
      earned,
      direct,
      paid,
      performance: direct > 0 ? Math.round((1000 * earned) / direct) / 10 : null,
      utilisation: paid > 0 ? Math.round((1000 * (direct + indirect)) / paid) / 10 : null,
      eligible: rows.filter((r) => r.incentive_eligible).length,
      belowTarget: rows.filter(
        (r) => r.performance_variance !== null && Number(r.performance_variance) < 0,
      ).length,
    };
  }, [rows]);

  const openTargetDialog = () => {
    setTargetForm({ ...EMPTY_TARGET, warehouse_id: scoped ?? null });
    setTargetOpen(true);
  };

  const openCoachDialog = (row: ScorecardRow) => {
    setCoachRow(row);
    setCoachBody("");
    setCoachOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Measurement window</Label>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  Last {w} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={openTargetDialog}>
          <Plus className="h-4 w-4 mr-2" /> Performance target
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {totals.performance === null ? "—" : `${totals.performance}%`}
            </div>
            <p className="text-xs text-muted-foreground">
              {hours(totals.earned)}h earned / {hours(totals.direct)}h direct
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Utilisation</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {totals.utilisation === null ? "—" : `${totals.utilisation}%`}
            </div>
            <p className="text-xs text-muted-foreground">{hours(totals.paid)}h on the clock</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">At or above target</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{totals.eligible}</div>
            <p className="text-xs text-muted-foreground">of {rows.length} operators</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Below target</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{totals.belowTarget}</div>
            <p className="text-xs text-muted-foreground">need coaching</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operator scorecard</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operator</TableHead>
                <TableHead className="text-right">Tasks</TableHead>
                <TableHead className="text-right">Earned h</TableHead>
                <TableHead className="text-right">Direct h</TableHead>
                <TableHead className="text-right">Perf %</TableHead>
                <TableHead className="text-right">vs target</TableHead>
                <TableHead className="text-right">Util %</TableHead>
                <TableHead className="text-right">vs target</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                    Loading scorecard…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                    No active operators in this window.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.operator_id}>
                  <TableCell>
                    <div className="font-medium">{r.operator_name}</div>
                    <div className="text-xs text-muted-foreground">{r.operator_code ?? "—"}</div>
                  </TableCell>
                  <TableCell className="text-right">{r.tasks_completed}</TableCell>
                  <TableCell className="text-right">{hours(Number(r.earned_seconds))}</TableCell>
                  <TableCell className="text-right">{hours(Number(r.direct_seconds))}</TableCell>
                  <TableCell className="text-right">
                    {r.performance_pct === null ? "—" : `${r.performance_pct}%`}
                  </TableCell>
                  <TableCell className="text-right">
                    <VarianceBadge value={r.performance_variance} />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.utilisation_pct === null ? "—" : `${r.utilisation_pct}%`}
                  </TableCell>
                  <TableCell className="text-right">
                    <VarianceBadge value={r.utilisation_variance} />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Log coaching note"
                      onClick={() => openCoachDialog(r)}
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4" /> Targets in force
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Task type</TableHead>
                <TableHead className="text-right">Perf %</TableHead>
                <TableHead className="text-right">Util %</TableHead>
                <TableHead className="text-right">Incentive at</TableHead>
                <TableHead className="text-right">Rate / earned h</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(targets ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    No targets yet — operators are measured without a goal.
                  </TableCell>
                </TableRow>
              )}
              {(targets ?? []).map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    {t.operator_id
                      ? "Single operator"
                      : t.warehouse_id
                        ? warehouses.find((w) => w.id === t.warehouse_id)?.name ?? "Warehouse"
                        : "Business-wide"}
                  </TableCell>
                  <TableCell>{t.task_type ?? "All"}</TableCell>
                  <TableCell className="text-right">{t.target_performance_pct}</TableCell>
                  <TableCell className="text-right">{t.target_utilisation_pct}</TableCell>
                  <TableCell className="text-right">{t.incentive_threshold_pct ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {Number(t.incentive_rate_per_earned_hour ?? 0) || "—"}
                  </TableCell>
                  <TableCell>{t.effective_from}</TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Remove target"
                      onClick={() => deleteTarget.mutate(t.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={targetOpen} onOpenChange={setTargetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Performance target</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label>Warehouse</Label>
              <Select
                value={targetForm.warehouse_id ?? ANY}
                onValueChange={(v) =>
                  setTargetForm((f) => ({ ...f, warehouse_id: v === ANY ? null : v }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All warehouses</SelectItem>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Task type</Label>
              <Select
                value={targetForm.task_type ?? ANY}
                onValueChange={(v) =>
                  setTargetForm((f) => ({
                    ...f,
                    task_type: v === ANY ? null : (v as WmsTaskType),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All task types</SelectItem>
                  {WMS_TASK_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>Performance %</Label>
                <Input
                  type="number"
                  min={1}
                  value={targetForm.target_performance_pct}
                  onChange={(e) =>
                    setTargetForm((f) => ({ ...f, target_performance_pct: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Utilisation %</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={targetForm.target_utilisation_pct}
                  onChange={(e) =>
                    setTargetForm((f) => ({ ...f, target_utilisation_pct: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Incentive at %</Label>
                <Input
                  type="number"
                  min={1}
                  value={targetForm.incentive_threshold_pct ?? ""}
                  placeholder="target"
                  onChange={(e) =>
                    setTargetForm((f) => ({
                      ...f,
                      incentive_threshold_pct: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Incentive rate per earned hour</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={targetForm.incentive_rate_per_earned_hour}
                onChange={(e) =>
                  setTargetForm((f) => ({
                    ...f,
                    incentive_rate_per_earned_hour: Number(e.target.value || 0),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Pay staged for payroll is earned hours × this rate. Zero means this
                target earns no incentive pay.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Effective from</Label>
                <Input
                  type="date"
                  value={targetForm.effective_from}
                  onChange={(e) =>
                    setTargetForm((f) => ({ ...f, effective_from: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Effective to</Label>
                <Input
                  type="date"
                  value={targetForm.effective_to ?? ""}
                  onChange={(e) =>
                    setTargetForm((f) => ({ ...f, effective_to: e.target.value || null }))
                  }
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="target-active">Active</Label>
              <Switch
                id="target-active"
                checked={targetForm.is_active}
                onCheckedChange={(v) => setTargetForm((f) => ({ ...f, is_active: v }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={targetForm.notes ?? ""}
                onChange={(e) => setTargetForm((f) => ({ ...f, notes: e.target.value || null }))}
                placeholder="Why this target exists"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTargetOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={saveTarget.isPending}
              onClick={() =>
                saveTarget.mutate(targetForm, { onSuccess: () => setTargetOpen(false) })
              }
            >
              Save target
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={coachOpen} onOpenChange={setCoachOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Coaching note — {coachRow?.operator_name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Note</Label>
            <Textarea
              rows={5}
              value={coachBody}
              onChange={(e) => setCoachBody(e.target.value)}
              placeholder="What was observed, what good looks like, what happens next"
            />
            <p className="text-xs text-muted-foreground">
              Saved to the operator's employee feedback record, visible to their manager.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCoachOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={logNote.isPending || !coachBody.trim() || !coachRow}
              onClick={() =>
                coachRow &&
                logNote.mutate(
                  { operatorId: coachRow.operator_id, body: coachBody.trim() },
                  { onSuccess: () => setCoachOpen(false) },
                )
              }
            >
              Save note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default LabourPerformancePanel;
