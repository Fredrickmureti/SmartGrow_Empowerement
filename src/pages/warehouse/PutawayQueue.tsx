/**
 * PutawayQueue — Phase 2 supervisor view.
 *
 * Three-column board (Pending / In progress / Done today) filtered to
 * `task_type = 'putaway'`. The queue is seeded exclusively by posting a
 * receiving session (`wms_post_receiving_session`) — there is no
 * after-the-fact staging entry point here. Completes putaway tasks via
 * `complete_putaway_task` (the RPC that
 * atomically moves the LPN; the table triggers emit `warehouse.task.completed` + `warehouse.lpn.stored`).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Truck, Play, Check, PackageOpen } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useAuth } from "@/contexts/AuthContext";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { useTaskEngine } from "@/features/warehouse/tasks/useTaskEngine";
import { PutawayTaskActions } from "@/features/warehouse/putaway/PutawayTaskActions";
import { PutawaySuggestionChips } from "@/features/warehouse/putaway/PutawaySuggestionChips";

interface PutawayRow {
  id: string;
  state: "pending" | "available" | "claimed" | "in_progress" | "paused" | "resumed" | "completed" | "cancelled" | "exception";
  priority: number;
  quantity: number | null;
  lpn_id: string | null;
  product_id: string | null;
  lot_number: string | null;
  destination_location_id: string | null;
  source_location_id: string | null;
  created_at: string;
  completed_at: string | null;
  warehouse_id: string;
  assignee_user_id: string | null;
  row_version: number;
  lpn: { code: string } | null;
  source_loc: { code: string } | null;
  dest_loc: { code: string } | null;
  product: { name: string; sku: string | null } | null;
}

const STATE_TONE: Record<string, "info" | "warning" | "success" | "neutral" | "danger"> = {
  pending: "neutral",
  available: "neutral",
  assigned: "info",
  claimed: "info",
  in_progress: "warning",
  done: "success",
  completed: "success",
  cancelled: "danger",
  exception: "danger",
};

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export default function PutawayQueue() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const { user } = useAuth();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-putaway", currentBusiness?.id, warehouseFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_tasks")
        .select("id, state, priority, quantity, lpn_id, product_id, lot_number, destination_location_id, source_location_id, created_at, completed_at, warehouse_id, assignee_user_id, row_version, lpn:lpn_id(code), source_loc:source_location_id(code), dest_loc:destination_location_id(code), product:product_id(name, sku)")
        .eq("business_id", currentBusiness!.id)
        .eq("task_type", "putaway")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(500);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as PutawayRow[];
    },
  });

  const complete = useMutation({
    mutationFn: async (id: string) => {
      await replayGuardedCall("complete_putaway_task", { p_task_id: id });
    },
    onSuccess: () => {
      toast.success("Putaway completed");
      qc.invalidateQueries({ queryKey: ["wms-putaway"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Putaway failed"),
  });

  const engine = useTaskEngine();

  const startAndClaim = (row: PutawayRow) => {
    if (!user?.id) { toast.error("Sign in required"); return; }
    // Route through the FSM RPC — enforces row_version optimistic lock and
    // emits `warehouse.task.in_progress` to the outbox.
    engine.transition.mutate({
      taskId: row.id,
      toState: "in_progress",
      rowVersion: row.row_version,
      reason: "started from putaway board",
    });
  };

  const cols = useMemo(() => {
    const pending = (rows ?? []).filter((r) => r.state === "pending" || r.state === "available" || r.state === "claimed");
    const inProgress = (rows ?? []).filter((r) => r.state === "in_progress");
    const doneToday = (rows ?? []).filter((r) => r.state === "completed" && isToday(r.completed_at));
    return { pending, inProgress, doneToday };
  }, [rows]);

  // Phase 2.4 — unit truth: pack rollup + the product's own base UoM label.
  const taskProductIds = useMemo(() => (rows ?? []).map((r) => r.product_id), [rows]);
  const qtyBaseLabels = useProductBaseUomLabels(taskProductIds);
  const qtyFmt = useWarehouseQtyFormatter(taskProductIds, qtyBaseLabels);


  const renderCard = (t: PutawayRow) => (
    <Card key={t.id} className="mb-2">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-mono">{t.lpn?.code ?? "—"}</div>
          <StatusBadge tone={STATE_TONE[t.state] ?? "neutral"}>{t.state.replace("_", " ")}</StatusBadge>
        </div>
        <div className="text-sm">
          {t.product?.name ?? "—"}
          {t.product?.sku ? <span className="text-muted-foreground"> · {t.product.sku}</span> : null}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-mono">{t.source_loc?.code ?? "?"}</span>
          <span className="mx-1">→</span>
          <span className="font-mono">{t.dest_loc?.code ?? "unassigned"}</span>
          {t.quantity != null ? <span className="ml-2">· qty {Number(t.quantity).toFixed(2)}</span> : null}
          {t.lot_number ? <span className="ml-2">· lot {t.lot_number}</span> : null}
        </div>
        {t.state !== "completed" && t.state !== "cancelled" && (
          <PutawaySuggestionChips taskId={t.id} />
        )}
        <div className="flex gap-1 justify-end pt-1">
          {t.lpn_id && (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/warehouse-app/plates/${t.lpn_id}`}>Plate</Link>
            </Button>
          )}
          {t.destination_location_id && t.dest_loc?.code && (
            <PrintLabelButton
              label="Bin"
              size="sm"
              variant="ghost"
              templateKey="bin_label"
              workflow="receiving"
              product={{
                id: t.destination_location_id,
                name: `Bin ${t.dest_loc.code}`,
                sku: t.dest_loc.code,
                barcode: null,
              }}
              sourceDocType="stock_location"
              sourceDocId={t.destination_location_id}
              idempotencyKey={`bin_label:${t.destination_location_id}`}
              extraVars={{ bin_code: t.dest_loc.code }}
            />
          )}
          {(t.state === "pending" || t.state === "available" || t.state === "claimed") && (
            <Button size="sm" variant="outline" onClick={() => startAndClaim(t)} disabled={engine.transition.isPending}>
              <Play className="h-3.5 w-3.5 mr-1" /> Start
            </Button>
          )}
          {t.state !== "completed" && t.state !== "cancelled" && (
            <PutawayTaskActions
              compact
              task={{
                id: t.id,
                warehouse_id: t.warehouse_id,
                quantity: t.quantity,
                destination_location_id: t.destination_location_id,
              }}
            />
          )}
          {(t.state === "claimed" || t.state === "in_progress" || t.state === "pending") && t.destination_location_id && (
            <Button size="sm" onClick={() => complete.mutate(t.id)}>
              <Check className="h-3.5 w-3.5 mr-1" /> Complete
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Putaway"
        description="Move staged receipts to their storage bin. Complete moves the plate atomically and posts warehouse.task.completed and warehouse.lpn.stored events."
        actions={
          <div className="flex gap-2">
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="w-full @xl/page:w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button asChild>
              <Link to="/warehouse-app/receiving">
                <Truck className="h-4 w-4 mr-2" /> Receiving sessions
              </Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        <Section>
          {isLoading ? (
            <LoadingState />
          ) : (rows ?? []).length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="No putaway tasks"
              description="Post a receiving session to seed the queue."
              action={<Button asChild><Link to="/warehouse-app/receiving"><Truck className="h-4 w-4 mr-2" /> Receiving sessions</Link></Button>}
            />
          ) : (
            <div className="min-w-0 grid gap-4 @2xl/page:grid-cols-3">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Pending ({cols.pending.length})</CardTitle></CardHeader>
                <CardContent className="p-2 max-h-[70vh] overflow-auto">
                  {cols.pending.length === 0 ? <div className="text-sm text-muted-foreground p-2">Clear.</div> : cols.pending.map(renderCard)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">In progress ({cols.inProgress.length})</CardTitle></CardHeader>
                <CardContent className="p-2 max-h-[70vh] overflow-auto">
                  {cols.inProgress.length === 0 ? <div className="text-sm text-muted-foreground p-2">Idle.</div> : cols.inProgress.map(renderCard)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Done today ({cols.doneToday.length})</CardTitle></CardHeader>
                <CardContent className="p-2 max-h-[70vh] overflow-auto">
                  {cols.doneToday.length === 0 ? <div className="text-sm text-muted-foreground p-2">—</div> : cols.doneToday.map(renderCard)}
                </CardContent>
              </Card>
            </div>
          )}
        </Section>
      </PageBody>
    </>
  );
}
