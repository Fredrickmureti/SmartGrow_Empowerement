/**
 * OperatorTasks — universal WMS task queue (ADR 0079, Phase 1).
 *
 * Every physical action in the warehouse — putaway, pick, pack, load,
 * count, replenish, move, QC — is a row in `wms_tasks`. This queue is
 * the operator's single work surface.
 *
 * Phase 1 ships the queue substrate + ad-hoc "move" task creation so
 * operators can exercise the workflow before receiving/put-away land in
 * Phase 2/3.
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
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { ListChecks, Plus, Play, Check, X, UserPlus } from "lucide-react";

type TaskType = "putaway" | "pick" | "pack" | "load" | "count" | "replenish" | "move" | "qc";
type TaskState = "pending" | "assigned" | "in_progress" | "done" | "cancelled";

interface TaskRow {
  id: string;
  task_type: TaskType;
  state: TaskState;
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
  source_loc: { code: string } | null;
  dest_loc: { code: string } | null;
}

const STATE_TONE: Record<TaskState, "info" | "warning" | "success" | "muted" | "danger"> = {
  pending: "muted",
  assigned: "info",
  in_progress: "warning",
  done: "success",
  cancelled: "danger",
};

const TASK_TYPES: TaskType[] = ["putaway", "pick", "pack", "load", "count", "replenish", "move", "qc"];

export default function OperatorTasks() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("open");
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState(false);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-tasks", currentBusiness?.id, typeFilter, stateFilter, warehouseFilter, mineOnly, user?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_tasks")
        .select("id, task_type, state, priority, sla_at, assignee_user_id, warehouse_id, source_location_id, destination_location_id, product_id, lot_number, quantity, started_at, completed_at, created_at, notes, cancel_reason, source_loc:source_location_id(code), dest_loc:destination_location_id(code)")
        .eq("business_id", currentBusiness!.id)
        .order("priority", { ascending: false })
        .order("sla_at", { ascending: true, nullsFirst: false })
        .limit(500);
      if (typeFilter !== "all") q = q.eq("task_type", typeFilter as TaskType);
      if (stateFilter === "open") q = q.in("state", ["pending", "assigned", "in_progress"]);
      else if (stateFilter !== "all") q = q.eq("state", stateFilter as TaskState);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (mineOnly && user?.id) q = q.eq("assignee_user_id", user.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as TaskRow[];
    },
  });

  const patch = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<TaskRow> }) => {
      const { error } = await supabase.from("wms_tasks").update(input.patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-tasks"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  const claim = (t: TaskRow) => {
    if (!user?.id) return;
    patch.mutate({ id: t.id, patch: { assignee_user_id: user.id, state: "assigned" } });
  };
  const start = (t: TaskRow) => patch.mutate({
    id: t.id,
    patch: {
      state: "in_progress",
      started_at: new Date().toISOString(),
      assignee_user_id: t.assignee_user_id ?? user?.id ?? null,
    },
  });
  const complete = (t: TaskRow) => patch.mutate({
    id: t.id,
    patch: { state: "done", completed_at: new Date().toISOString() },
  });

  const [cancelOpen, setCancelOpen] = useState<TaskRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const cancel = () => {
    if (!cancelOpen) return;
    patch.mutate(
      { id: cancelOpen.id, patch: { state: "cancelled", cancel_reason: cancelReason || null, completed_at: new Date().toISOString() } },
      { onSuccess: () => { setCancelOpen(null); setCancelReason(""); toast.success("Task cancelled"); } },
    );
  };

  // ---------- ad-hoc create ------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    task_type: "move" as TaskType,
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
        task_type: form.task_type,
        state: "pending",
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
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
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
        description="Universal queue of physical work — putaway, pick, pack, load, count, replenish, move, QC."
        actions={<Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" /> New task</Button>}
      />
      <PageBody>
        <Section>
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={stateFilter} onValueChange={setStateFilter}>
                  <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open (default)</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="assigned">Assigned</SelectItem>
                    <SelectItem value="in_progress">In progress</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-[140px]"><SelectValue placeholder="Type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {TASK_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                  <SelectTrigger className="w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
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
                <EmptyState icon={ListChecks} title={emptyLabel} description="Create an ad-hoc task or wait for downstream workflows to seed one." />
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
                        <TableCell><StatusBadge tone={STATE_TONE[t.state]} label={t.state.replace("_", " ")} /></TableCell>
                        <TableCell>{t.priority}</TableCell>
                        <TableCell className="text-sm">
                          <span className="font-mono">{t.source_loc?.code ?? "—"}</span>
                          <span className="mx-1 text-muted-foreground">→</span>
                          <span className="font-mono">{t.dest_loc?.code ?? "—"}</span>
                        </TableCell>
                        <TableCell className="font-mono text-sm">{t.quantity != null ? Number(t.quantity).toFixed(2) : "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {t.sla_at ? new Date(t.sla_at).toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          {t.state === "pending" && (
                            <Button size="sm" variant="outline" onClick={() => claim(t)}><UserPlus className="h-3.5 w-3.5" /></Button>
                          )}
                          {(t.state === "pending" || t.state === "assigned") && (
                            <Button size="sm" variant="outline" onClick={() => start(t)}><Play className="h-3.5 w-3.5" /></Button>
                          )}
                          {(t.state === "assigned" || t.state === "in_progress") && (
                            <Button size="sm" onClick={() => complete(t)}><Check className="h-3.5 w-3.5" /></Button>
                          )}
                          {t.state !== "done" && t.state !== "cancelled" && (
                            <Button size="sm" variant="ghost" onClick={() => setCancelOpen(t)}><X className="h-3.5 w-3.5" /></Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Section>
      </PageBody>

      <Dialog open={!!cancelOpen} onOpenChange={(o) => !o && setCancelOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel task</DialogTitle></DialogHeader>
          <Textarea placeholder="Reason (recommended)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Type</Label>
                <Select value={form.task_type} onValueChange={(v) => setForm({ ...form, task_type: v as TaskType })}>
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
            <div className="grid grid-cols-2 gap-3">
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
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.warehouse_id}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
