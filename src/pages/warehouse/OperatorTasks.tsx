/**
 * OperatorTasks — universal WMS task queue (ADR 0079 + ADR 0101).
 *
 * Every physical action in the warehouse is a row in `wms_tasks`. This is
 * the operator's single work surface. Phase 1.3 rewires all state
 * mutations through the FSM RPCs (`wms_transition_task`,
 * `wms_claim_next_task`) so `row_version` optimistic concurrency and the
 * outbox event stay in sync. Direct `.update({ state })` is forbidden.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { useTaskEngine } from "@/features/warehouse/tasks/useTaskEngine";
import { ReplenishCompleteDialog } from "@/features/warehouse/replenishment/ReplenishCompleteDialog";
import { TaskHistorySheet } from "@/features/warehouse/tasks/TaskHistorySheet";
import { useWarehouseQtyFormatter, WarehouseQty } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";
import { TASK_TYPES, TASK_OPEN_STATES, TASK_HELD_STATES, type WmsTaskType, type WmsTaskState } from "@/features/warehouse/events/topics";
import { ClipboardList, ListChecks, Plus, Play, Check, X, UserPlus, Zap, RefreshCw, History } from "lucide-react";


interface TaskRow {
  id: string;
  task_type: WmsTaskType;
  state: WmsTaskState;
  priority: number;
  sla_at: string | null;
  assignee_user_id: string | null;
  warehouse_id: string;
  source_location_id: string | null;
  destination_location_id: string | null;
  product_id: string | null;
  lot_number: string | null;
  quantity: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  notes: string | null;
  cancel_reason: string | null;
  row_version: number;
  source_doc_type: string | null;
  source_doc_id: string | null;
  source_loc: { code: string } | null;
  dest_loc: { code: string } | null;
}

const STATE_TONE: Record<string, "info" | "warning" | "success" | "neutral" | "danger"> = {
  pending: "neutral",
  available: "neutral",
  claimed: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "danger",
  exception: "danger",
};

export default function OperatorTasks() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const engine = useTaskEngine();
  const navigate = useNavigate();

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("open");
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState(false);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms_tasks", currentBusiness?.id, typeFilter, stateFilter, warehouseFilter, mineOnly, user?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_tasks")
        .select("id, task_type, state, priority, sla_at, assignee_user_id, warehouse_id, source_location_id, destination_location_id, product_id, lot_number, quantity, started_at, completed_at, created_at, notes, cancel_reason, row_version, source_doc_type, source_doc_id, source_loc:source_location_id(code), dest_loc:destination_location_id(code)")
        .eq("business_id", currentBusiness!.id)
        .order("priority", { ascending: false })
        .order("sla_at", { ascending: true, nullsFirst: false })
        .limit(500);
      if (typeFilter !== "all") q = q.eq("task_type", typeFilter as any);
      if (stateFilter === "open") q = q.in("state", [...TASK_OPEN_STATES] as any);
      else if (stateFilter !== "all") q = q.eq("state", stateFilter as any);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (mineOnly && user?.id) q = q.eq("assignee_user_id", user.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as TaskRow[];
    },
  });

  const completePutaway = useMutation({
    mutationFn: async (id: string) => {
      await replayGuardedCall("complete_putaway_task", { p_task_id: id });
    },
    onSuccess: () => {
      toast.success("Putaway completed");
      qc.invalidateQueries({ queryKey: ["wms_tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Putaway failed"),
  });

  const transition = (t: TaskRow, to: WmsTaskState, reason?: string) =>
    engine.transition.mutate({ taskId: t.id, toState: to, rowVersion: t.row_version, reason });

  const claim = (t: TaskRow) => transition(t, "claimed");
  const [historyTask, setHistoryTask] = useState<TaskRow | null>(null);

  // Phase 2.4 — task quantities render with the product's pack/base UoM truth.
  const taskProductIds = useMemo(() => (rows ?? []).map((t) => t.product_id), [rows]);
  const taskBaseLabels = useProductBaseUomLabels(taskProductIds);
  const qtyFmt = useWarehouseQtyFormatter(taskProductIds, taskBaseLabels);

  const isCountTask = (t: TaskRow) =>
    t.task_type === "count" && t.source_doc_type === "wms_count_session" && !!t.source_doc_id;
  const openCount = (t: TaskRow) => {
    if (!t.source_doc_id) { toast.error("This count task has no session"); return; }
    navigate(`/warehouse-app/counts/${t.source_doc_id}`);
  };
  const start = (t: TaskRow) => transition(t, "in_progress");
  const [replenTask, setReplenTask] = useState<TaskRow | null>(null);

  const complete = (t: TaskRow) => {
    if (t.task_type === "putaway") {
      completePutaway.mutate(t.id);
      return;
    }
    if (t.task_type === "count") {
      // A count task closes on evidence (record_count), never on a click.
      // Send the operator to the bin instead of faking completion.
      openCount(t);
      return;
    }
    if (t.task_type === "replenish") {
      // Replenishment must move stock — capture the scans + moved qty.
      setReplenTask(t);
      return;
    }
    transition(t, "completed");
  };

  const [cancelOpen, setCancelOpen] = useState<TaskRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [alsoRaiseException, setAlsoRaiseException] = useState(false);

  const raiseException = useMutation({
    mutationFn: async (input: { task: TaskRow; reason: string }) => {
      const { error } = await supabase.rpc("wms_raise_exception" as any, {
        p_warehouse_id: input.task.warehouse_id,
        p_kind: "stale_task",
        p_reason: input.reason || `Task ${input.task.task_type} cancelled`,
        p_aggregate_type: "wms_task",
        p_aggregate_id: input.task.id,
        p_task_id: input.task.id,
        p_lpn_id: null,
        p_severity: 2,
        p_details: { task_type: input.task.task_type },
      });
      if (error) throw error;
    },
  });

  const cancel = () => {
    if (!cancelOpen) return;
    const target = cancelOpen;
    engine.transition.mutate(
      { taskId: target.id, toState: "cancelled", rowVersion: target.row_version, reason: cancelReason || undefined },
      {
        onSuccess: async () => {
          if (alsoRaiseException) {
            try {
              await raiseException.mutateAsync({ task: target, reason: cancelReason });
              toast.success("Task cancelled and exception raised");
            } catch (e: unknown) {
              toast.error(e instanceof Error ? e.message : "Cancelled, but could not raise exception");
            }
          } else {
            toast.success("Task cancelled");
          }
          setCancelOpen(null); setCancelReason(""); setAlsoRaiseException(false);
          qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
        },
      },
    );
  };


  // ---------- claim-next ----------------------------------------------
  const claimNext = () => {
    const warehouseId = warehouseFilter !== "all" ? warehouseFilter : warehouses[0]?.id;
    if (!warehouseId) { toast.error("Choose a warehouse first"); return; }
    engine.claimNext.mutate({
      warehouseId,
      taskTypes: typeFilter !== "all" ? [typeFilter as WmsTaskType] : undefined,
    });
  };

  const reapExpired = () => {
    const warehouseId = warehouseFilter !== "all" ? warehouseFilter : warehouses[0]?.id;
    if (!warehouseId) { toast.error("Choose a warehouse first"); return; }
    engine.reapExpired.mutate(warehouseId);
  };

  // ---------- ad-hoc create ------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    task_type: "move" as WmsTaskType,
    warehouse_id: "",
    source_location_id: "",
    destination_location_id: "",
    quantity: "",
    priority: "100",
    notes: "",
  });

  const { data: locOptions } = useQuery({
    queryKey: ["wms-tasks-loc-options", form.warehouse_id],
    enabled: !!form.warehouse_id && createOpen,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, code, name")
        .eq("warehouse_id", form.warehouse_id)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("No active organization");
      if (!form.warehouse_id) throw new Error("Choose a warehouse");
      const wh = warehouses.find((w) => w.id === form.warehouse_id);
      const { error } = await supabase.from("wms_tasks").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: wh?.branch_id ?? null,
        warehouse_id: form.warehouse_id,
        task_type: form.task_type as any,
        state: "available" as any,
        priority: Number(form.priority) || 100,
        source_location_id: form.source_location_id || null,
        destination_location_id: form.destination_location_id || null,
        quantity: form.quantity ? Number(form.quantity) : null,
        notes: form.notes || null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Task created");
      setCreateOpen(false);
      setForm({ task_type: "move", warehouse_id: "", source_location_id: "", destination_location_id: "", quantity: "", priority: "100", notes: "" });
      qc.invalidateQueries({ queryKey: ["wms_tasks"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Create failed"),
  });

  const emptyLabel = useMemo(() => {
    if (stateFilter === "open") return "No open tasks";
    return "No tasks match these filters";
  }, [stateFilter]);

  return (
    <>
      <PageHeader
        title="Operator tasks"
        description="Universal queue of physical work — putaway, pick, pack, load, count, replenish, move, QC, receive, return."
        actions={
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button variant="outline" className="min-w-0 flex-1 sm:flex-none" onClick={reapExpired} disabled={engine.reapExpired.isPending}>
              <RefreshCw className="mr-2 h-4 w-4 shrink-0" /> <span className="truncate">Reap expired</span>
            </Button>
            <Button variant="outline" className="min-w-0 flex-1 sm:flex-none" onClick={claimNext} disabled={engine.claimNext.isPending}>
              <Zap className="mr-2 h-4 w-4 shrink-0" /> <span className="truncate">Claim next</span>
            </Button>
            <Button className="min-w-0 flex-1 sm:flex-none" onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4 shrink-0" /> <span className="truncate">New task</span></Button>
          </div>
        }
      />
      <PageBody>
        <Section>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-full @xl/page:w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open (default)</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="available">Available</SelectItem>
                  <SelectItem value="claimed">Claimed</SelectItem>
                  <SelectItem value="in_progress">In progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="exception">Exception</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full @xl/page:w-[140px]"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {TASK_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger className="w-full @xl/page:w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All warehouses</SelectItem>
                  {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>
                Mine only
              </Button>
            </div>

            {isLoading ? (
              <LoadingState />
            ) : (rows ?? []).length === 0 ? (
              <EmptyState icon={ListChecks} title={emptyLabel} description="Claim next, create an ad-hoc task, or wait for downstream workflows to seed one." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>From → To</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>SLA</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(rows ?? []).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="capitalize">{t.task_type}</TableCell>
                      <TableCell><StatusBadge tone={STATE_TONE[t.state] ?? "neutral"}>{t.state.replace("_", " ")}</StatusBadge></TableCell>
                      <TableCell>{t.priority}</TableCell>
                      <TableCell className="text-sm">
                        <span className="font-mono">{t.source_loc?.code ?? "—"}</span>
                        <span className="mx-1 text-muted-foreground">→</span>
                        <span className="font-mono">{t.dest_loc?.code ?? "—"}</span>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {t.quantity != null ? (
                          <WarehouseQty fmt={qtyFmt} productId={t.product_id} baseQty={t.quantity} />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {t.sla_at ? new Date(t.sla_at).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        {isCountTask(t) && (
                          <Button size="sm" variant="outline" onClick={() => openCount(t)}>
                            <ClipboardList className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {(t.state === "pending" || t.state === "available") && (
                          <Button size="sm" variant="outline" onClick={() => claim(t)}><UserPlus className="h-3.5 w-3.5" /></Button>
                        )}
                        {t.state === "claimed" && (
                          <Button size="sm" variant="outline" onClick={() => start(t)}><Play className="h-3.5 w-3.5" /></Button>
                        )}
                        {TASK_HELD_STATES.includes(t.state as (typeof TASK_HELD_STATES)[number]) && (
                          <Button size="sm" onClick={() => complete(t)}><Check className="h-3.5 w-3.5" /></Button>
                        )}
                        {t.state !== "completed" && t.state !== "cancelled" && (
                          <Button size="sm" variant="ghost" onClick={() => setCancelOpen(t)}><X className="h-3.5 w-3.5" /></Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Execution history"
                          onClick={() => setHistoryTask(t)}
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>

                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Section>
      </PageBody>

      <ReplenishCompleteDialog
        task={replenTask}
        onOpenChange={(o) => !o && setReplenTask(null)}
      />

      <TaskHistorySheet
        taskId={historyTask?.id ?? null}
        productId={historyTask?.product_id ?? null}
        taskLabel={historyTask ? `${historyTask.task_type} task` : undefined}
        onOpenChange={(o) => !o && setHistoryTask(null)}
      />


      <Dialog open={!!cancelOpen} onOpenChange={(o) => !o && setCancelOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel task</DialogTitle></DialogHeader>
          <Textarea placeholder="Reason (recommended)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={alsoRaiseException} onChange={(e) => setAlsoRaiseException(e.target.checked)} />
            Also raise an exception for triage
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(null)}>Keep</Button>
            <Button variant="destructive" onClick={cancel}>Cancel task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New operator task</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="min-w-0 grid grid-cols-2 gap-3">
              <div>
                <Label>Type</Label>
                <Select value={form.task_type} onValueChange={(v) => setForm({ ...form, task_type: v as WmsTaskType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority</Label>
                <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Warehouse</Label>
              <Select value={form.warehouse_id} onValueChange={(v) => setForm({ ...form, warehouse_id: v, source_location_id: "", destination_location_id: "" })}>
                <SelectTrigger><SelectValue placeholder="Choose warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 grid grid-cols-2 gap-3">
              <div>
                <Label>From (source)</Label>
                <Select value={form.source_location_id || "none"} onValueChange={(v) => setForm({ ...form, source_location_id: v === "none" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {(locOptions ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>To (destination)</Label>
                <Select value={form.destination_location_id || "none"} onValueChange={(v) => setForm({ ...form, destination_location_id: v === "none" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {(locOptions ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Quantity (optional)</Label>
              <Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
