/**
 * Mobile pick — scan source bin + product SKU, enter qty, confirm.
 *
 * The bin leg goes through `BinScanField` so the label barcode resolves via
 * `resolve_location_identity` (ADR 0104) instead of a code string compare.
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
import { BinScanField } from "@/features/warehouse/locations/BinScanField";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";

interface Task {
  id: string;
  state: string;
  quantity: number | null;
  lot_number: string | null;
  warehouse_id: string | null;
  source_location_id: string | null;
  source_loc: { code: string | null } | null;
  dest_loc: { code: string | null } | null;
  product: { sku: string | null; name: string | null } | null;
}

export default function MobilePick() {
  const { id } = useParams();
  const nav = useNavigate();
  const [binConfirmed, setBinConfirmed] = useState(false);
  const [skuScan, setSkuScan] = useState("");
  const [qty, setQty] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const { data: task, isLoading } = useQuery({
    queryKey: ["wm-pick-task", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select(
          "id, state, quantity, lot_number, warehouse_id, source_location_id, source_loc:source_location_id(code), dest_loc:destination_location_id(code), product:product_id(sku, name)",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      const t = data as unknown as Task | null;
      if (t?.quantity != null && !qty) setQty(String(t.quantity));
      return t;
    },
  });

  const submit = async () => {
    if (!task) return;
    const expectedSku = (task.product?.sku ?? "").toLowerCase();
    if (!binConfirmed) {
      toast.error(`Scan ${task.source_loc?.code ?? "the source bin"} first`);
      return;
    }
    if (skuScan.trim().toLowerCase() !== expectedSku) {
      toast.error(`Wrong product — scan ${task.product?.sku}`);
      return;
    }
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue("complete_pick_task", {
        p_task_id: task.id,
        p_picked_qty: n,
        p_lpn_id: null,
      });
      toast.success(r.queued ? "Queued (offline)" : "Pick confirmed");
      nav("/wm");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <MobileWarehouseLayout title="Pick" back="/wm">Loading…</MobileWarehouseLayout>;
  if (!task) return <MobileWarehouseLayout title="Pick" back="/wm">Task not found.</MobileWarehouseLayout>;

  const done = task.state === "done";
  return (
    <MobileWarehouseLayout
      title="Pick"
      back="/wm"
      bottomBar={
        <Button className="w-full h-12" size="lg" disabled={busy || done} onClick={submit}>
          {done ? "Completed" : busy ? "Working…" : "Confirm pick"}
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
            <div className="font-mono text-primary">{task.source_loc?.code ?? "—"}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-xs text-muted-foreground">To</div>
            <div className="font-mono">{task.dest_loc?.code ?? "—"}</div>
          </div>
        </div>
        <BinScanField
          label="Scan source bin"
          intent="pick.location"
          expectedLocationId={task.source_location_id}
          expectedCode={task.source_loc?.code ?? null}
          warehouseId={task.warehouse_id}
          disabled={done}
          onConfirmedChange={setBinConfirmed}
        />
        <div>
          <Label>Scan product SKU</Label>
          <Input
            value={skuScan}
            onChange={(e) => setSkuScan(e.target.value)}
            placeholder={task.product?.sku ?? ""}
            className="h-12 text-lg font-mono"
          />
        </div>
        <div>
          <Label>Picked qty</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="h-12 text-lg"
          />
        </div>
      </div>
    </MobileWarehouseLayout>
  );
}
