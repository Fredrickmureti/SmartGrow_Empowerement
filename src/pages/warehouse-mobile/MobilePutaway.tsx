/**
 * Mobile put-away — scan bin barcode to confirm destination, then confirm.
 */
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";

interface Task {
  id: string;
  state: string;
  quantity: number | null;
  lot_number: string | null;
  destination_location_id: string | null;
  source_loc: { code: string | null } | null;
  dest_loc: { code: string | null } | null;
  product: { sku: string | null; name: string | null } | null;
}

export default function MobilePutaway() {
  const { id } = useParams();
  const nav = useNavigate();
  const [binScan, setBinScan] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: task, isLoading } = useQuery({
    queryKey: ["wm-putaway-task", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select(
          "id, state, quantity, lot_number, destination_location_id, source_loc:source_location_id(code), dest_loc:destination_location_id(code), product:product_id(sku, name)",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Task | null;
    },
  });

  const submit = async () => {
    if (!task) return;
    const expected = (task.dest_loc?.code ?? "").toLowerCase();
    if (!expected) {
      toast.error("Task has no destination bin");
      return;
    }
    if (binScan.trim().toLowerCase() !== expected) {
      toast.error(`Wrong bin — scan ${task.dest_loc?.code}`);
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue("complete_putaway_task", { p_task_id: task.id });
      toast.success(r.queued ? "Queued (offline)" : "Put-away confirmed");
      nav("/wm");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <MobileWarehouseLayout title="Put-away" back="/wm">Loading…</MobileWarehouseLayout>;
  if (!task) return <MobileWarehouseLayout title="Put-away" back="/wm">Task not found.</MobileWarehouseLayout>;

  const done = task.state === "done";
  return (
    <MobileWarehouseLayout
      title="Put-away"
      back="/wm"
      bottomBar={
        <Button className="w-full h-12" size="lg" disabled={busy || done} onClick={submit}>
          {done ? "Completed" : busy ? "Working…" : "Confirm put-away"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded border p-3">
          <div className="text-xs text-muted-foreground">Product</div>
          <div className="font-medium">{task.product?.name ?? "—"}</div>
          <div className="font-mono text-xs">{task.product?.sku}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border p-3">
            <div className="text-xs text-muted-foreground">From</div>
            <div className="font-mono">{task.source_loc?.code ?? "—"}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-xs text-muted-foreground">To</div>
            <div className="font-mono text-primary">{task.dest_loc?.code ?? "—"}</div>
          </div>
        </div>
        <div className="rounded border p-3">
          <div className="text-xs text-muted-foreground">Qty · Lot</div>
          <div>
            {task.quantity ?? "—"}{task.lot_number ? ` · ${task.lot_number}` : ""}
          </div>
        </div>
        <div>
          <Label>Scan destination bin</Label>
          <Input
            autoFocus
            inputMode="text"
            value={binScan}
            onChange={(e) => setBinScan(e.target.value)}
            placeholder={task.dest_loc?.code ?? ""}
            className="h-12 text-lg font-mono"
          />
        </div>
      </div>
    </MobileWarehouseLayout>
  );
}
