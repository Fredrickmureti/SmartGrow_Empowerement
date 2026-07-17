/**
 * Labour Board — Phase 10.
 *
 * Engineered labour standards + operator productivity.
 *
 *  - `wms_task_standards` is master data (seconds_per_uom per task_type).
 *  - `wms_tasks.earned_seconds` / `actual_seconds` are stamped by the
 *    `_wms_stamp_labour_metrics` BEFORE-UPDATE trigger when a task
 *    transitions to `state='done'`. Direct client writes to those
 *    columns are blocked at the DB.
 *  - `wms_operator_productivity_view` rolls up per operator / warehouse
 *    / day with a utilisation ratio (earned / actual).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Gauge, Plus, Trash2 } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";

type TaskType =
  | "putaway" | "pick" | "pack" | "load"
  | "count" | "replenish" | "move" | "qc";

const TASK_TYPES: TaskType[] = [
  "putaway", "pick", "pack", "load", "count", "replenish", "move", "qc",
];

interface Standard {
  id: string;
  task_type: TaskType;
  uom: string;
  seconds_per_uom: number;
  is_active: boolean;
  notes: string | null;
}

interface ProductivityRow {
  operator_id: string;
  warehouse_id: string;
  day: string;
  tasks_completed: number;
  earned_seconds: number;
  actual_seconds: number;
  utilisation_ratio: number | null;
}

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

export default function LabourBoard() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [rangeDays, setRangeDays] = useState<number>(7);
  const [standardOpen, setStandardOpen] = useState(false);

  const [form, setForm] = useState({
    task_type: "pick" as TaskType,
    uom: "unit",
    seconds_per_uom: 30,
    notes: "",
  });

  // ---------- Standards ----------
  const { data: standards, isLoading: standardsLoading } = useQuery({
    queryKey: ["wms-task-standards", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_task_standards")
        .select("id,task_type,uom,seconds_per_uom,is_active,notes")
        .eq("business_id", currentBusiness!.id)
        .order("task_type");
      if (error) throw error;
      return (data ?? []) as Standard[];
    },
  });

  const createStandard = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const { error } = await supabase.from("wms_task_standards").insert({
        business_id: currentBusiness.id,
        task_type: form.task_type,
        uom: form.uom.trim() || "unit",
        seconds_per_uom: Number(form.seconds_per_uom),
        notes: form.notes.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Standard saved");
      setStandardOpen(false);
      qc.invalidateQueries({ queryKey: ["wms-task-standards"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleStandard = useMutation({
    mutationFn: async (row: Standard) => {
      const { error } = await supabase
        .from("wms_task_standards")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-task-standards"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteStandard = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("wms_task_standards").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Standard removed");
      qc.invalidateQueries({ queryKey: ["wms-task-standards"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- Productivity ----------
  const since = useMemo(() => daysAgo(rangeDays), [rangeDays]);

  const { data: productivity, isLoading: prodLoading } = useQuery({
    queryKey: ["wms-operator-productivity", currentBusiness?.id, warehouseFilter, rangeDays],
    enabled: !!currentBusiness?.id,
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_operator_productivity_view")
        .select("operator_id,warehouse_id,day,tasks_completed,earned_seconds,actual_seconds,utilisation_ratio")
        .eq("business_id", currentBusiness!.id)
        .gte("day", since)
        .order("day", { ascending: false });
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ProductivityRow[];
    },
  });

  const leaderboard = useMemo(() => {
    const map = new Map<string, { earned: number; actual: number; tasks: number }>();
    for (const r of productivity ?? []) {
      const acc = map.get(r.operator_id) ?? { earned: 0, actual: 0, tasks: 0 };
      acc.earned += Number(r.earned_seconds) || 0;
      acc.actual += Number(r.actual_seconds) || 0;
      acc.tasks += r.tasks_completed;
      map.set(r.operator_id, acc);
    }
    return Array.from(map.entries())
      .map(([operator_id, v]) => ({
        operator_id,
        ...v,
        utilisation: v.actual > 0 ? v.earned / v.actual : null,
      }))
      .sort((a, b) => (b.utilisation ?? -1) - (a.utilisation ?? -1));
  }, [productivity]);

  const totals = useMemo(() => {
    return leaderboard.reduce(
      (acc, r) => {
        acc.earned += r.earned;
        acc.actual += r.actual;
        acc.tasks += r.tasks;
        return acc;
      },
      { earned: 0, actual: 0, tasks: 0 }
    );
  }, [leaderboard]);

  const overallUtil =
    totals.actual > 0 ? totals.earned / totals.actual : null;

  return (
    <>
      <PageHeader
        title="Labour management"
        description="Engineered standards, earned vs actual hours, per-operator utilisation."
        
        actions={
          <Button onClick={() => setStandardOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> New standard
          </Button>
        }
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

        {/* KPI cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <KpiCard label="Tasks completed" value={String(totals.tasks)} />
          <KpiCard label="Earned hours" value={fmtHours(totals.earned)} />
          <KpiCard label="Actual hours" value={fmtHours(totals.actual)} />
          <KpiCard
            label="Utilisation"
            value={overallUtil == null ? "—" : `${(overallUtil * 100).toFixed(0)}%`}
            tone={
              overallUtil == null ? undefined :
              overallUtil >= 0.9 ? "good" :
              overallUtil >= 0.7 ? "warn" : "bad"
            }
          />
        </div>

        <Section title="Operator leaderboard">
          {prodLoading ? (
            <LoadingState />
          ) : leaderboard.length === 0 ? (
            <EmptyState
              title="No completed tasks in range"
              description="Once operators start completing tasks, earned vs actual metrics will appear."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Operator</TableHead>
                  <TableHead className="text-right">Tasks</TableHead>
                  <TableHead className="text-right">Earned</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Utilisation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboard.map((r) => (
                  <TableRow key={r.operator_id}>
                    <TableCell className="font-mono text-xs">
                      {r.operator_id.slice(0, 8)}…
                    </TableCell>
                    <TableCell className="text-right">{r.tasks}</TableCell>
                    <TableCell className="text-right">{fmtHours(r.earned)}</TableCell>
                    <TableCell className="text-right">{fmtHours(r.actual)}</TableCell>
                    <TableCell className="text-right">
                      {r.utilisation == null ? "—" : `${(r.utilisation * 100).toFixed(0)}%`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

        <Section title="Engineered standards" description="Seconds per unit for each task type. Missing standards default to 0 earned seconds.">
          {standardsLoading ? (
            <LoadingState />
          ) : (standards ?? []).length === 0 ? (
            <EmptyState
              title="No standards yet"
              description="Add a standard so completed tasks stamp earned seconds."
              action={<Button onClick={() => setStandardOpen(true)}><Plus className="h-4 w-4 mr-2" />New standard</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task type</TableHead>
                  <TableHead>UoM</TableHead>
                  <TableHead className="text-right">Seconds / unit</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(standards ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="capitalize">{s.task_type}</TableCell>
                    <TableCell>{s.uom}</TableCell>
                    <TableCell className="text-right">{Number(s.seconds_per_uom).toFixed(1)}</TableCell>
                    <TableCell>
                      <Switch
                        checked={s.is_active}
                        onCheckedChange={() => toggleStandard.mutate(s)}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{s.notes ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteStandard.mutate(s.id)}
                        aria-label="Delete standard"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <Dialog open={standardOpen} onOpenChange={setStandardOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New labour standard</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-2">
            <div>
              <Label>Task type</Label>
              <Select
                value={form.task_type}
                onValueChange={(v) => setForm((f) => ({ ...f, task_type: v as TaskType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASK_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Unit of measure</Label>
                <Input
                  value={form.uom}
                  onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))}
                  placeholder="unit"
                />
              </div>
              <div>
                <Label>Seconds / unit</Label>
                <Input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={form.seconds_per_uom}
                  onChange={(e) => setForm((f) => ({ ...f, seconds_per_uom: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStandardOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createStandard.mutate()}
              disabled={createStandard.isPending || form.seconds_per_uom <= 0}
            >
              Save standard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function KpiCard({
  label, value, tone,
}: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const toneCls =
    tone === "good" ? "text-emerald-600" :
    tone === "warn" ? "text-amber-600" :
    tone === "bad"  ? "text-rose-600" : "";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`text-3xl font-semibold mt-1 ${toneCls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
