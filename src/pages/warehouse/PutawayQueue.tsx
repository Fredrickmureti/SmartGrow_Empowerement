/**
 * PutawayQueue — Phase 2 supervisor view.
 *
 * Three-column board (Pending / In progress / Done today) filtered to
 * `task_type = 'putaway'`. Kicks off receive-to-WMS staging and
 * completes putaway tasks via `complete_putaway_task` (the RPC that
 * atomically moves the LPN and emits `warehouse.putaway.completed`).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Truck, Play, Check, PackageOpen } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useAuth } from "@/contexts/AuthContext";
import { ReceiveToWMSDialog } from "./ReceiveToWMSDialog";

interface PutawayRow {
  id: string;
  state: "pending" | "assigned" | "in_progress" | "done" | "cancelled";
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
  lpn: { code: string } | null;
  source_loc: { code: string } | null;
  dest_loc: { code: string } | null;
  product: { name: string; sku: string | null } | null;
}

const STATE_TONE = {
  pending: "neutral",
  assigned: "info",
  in_progress: "warning",
  done: "success",
  cancelled: "danger",
} as const;

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
  const [receiveOpen, setReceiveOpen] = useState(false);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-putaway", currentBusiness?.id, warehouseFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_tasks")
        .select("id, state, priority, quantity, lpn_id, product_id, lot_number, destination_location_id, source_location_id, created_at, completed_at, warehouse_id, assignee_user_id, lpn:lpn_id(code), source_loc:source_location_id(code), dest_loc:destination_location_id(code), product:product_id(name, sku)")
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
      const { error } = await supabase.rpc("complete_putaway_task", { p_task_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Putaway completed");
      qc.invalidateQueries({ queryKey: ["wms-putaway"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Putaway failed"),
  });

  const startAndClaim = useMutation({
    mutationFn: async (id: string) => {
      if (!user?.id) throw new Error("Sign in required");
      const { error } = await supabase
        .from("wms_tasks")
        .update({ state: "in_progress", started_at: new Date().toISOString(), assignee_user_id: user.id })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-putaway"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const cols = useMemo(() => {
    const pending = (rows ?? []).filter((r) => r.state === "pending" || r.state === "assigned");
    const inProgress = (rows ?? []).filter((r) => r.state === "in_progress");
    const doneToday = (rows ?? []).filter((r) => r.state === "done" && isToday(r.completed_at));
    return { pending, inProgress, doneToday };
  }, [rows]);

  const renderCard = (t: PutawayRow) => (
    <Card key={t.id} className="mb-2">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-mono">{t.lpn?.code ?? "—"}</div>
          <StatusBadge tone={STATE_TONE[t.state]}>{t.state.replace("_", " ")}</StatusBadge>
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
        <div className="flex gap-1 justify-end pt-1">
          {t.lpn_id && (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/warehouse-app/plates/${t.lpn_id}`}>Plate</Link>
            </Button>
          )}
          {(t.state === "pending" || t.state === "assigned") && (
            <Button size="sm" variant="outline" onClick={() => startAndClaim.mutate(t.id)}>
              <Play className="h-3.5 w-3.5 mr-1" /> Start
            </Button>
          )}
          {(t.state === "assigned" || t.state === "in_progress" || t.state === "pending") && t.destination_location_id && (
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
        description="Move staged receipts to their storage bin. Complete moves the plate atomically and posts a warehouse.putaway.completed event."
        actions={
          <div className="flex gap-2">
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={() => setReceiveOpen(true)}>
              <Truck className="h-4 w-4 mr-2" /> Receive to WMS
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
              description="Stage a goods receipt to seed the queue."
              action={<Button onClick={() => setReceiveOpen(true)}><Truck className="h-4 w-4 mr-2" /> Receive to WMS</Button>}
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
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

      <ReceiveToWMSDialog
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        onStaged={() => qc.invalidateQueries({ queryKey: ["wms-putaway"] })}
      />
    </>
  );
}
