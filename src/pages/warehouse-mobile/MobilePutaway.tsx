/**
 * Mobile put-away — the operator proves they are standing at the right bin.
 *
 * Confirmation goes through `BinScanField`, so the physical label's barcode
 * resolves via `resolve_location_identity` (ADR 0104) rather than being
 * string-compared against the location code. A label whose barcode differs
 * from the code, or a code that exists in two warehouses, is handled there.
 */
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { BinScanField } from "@/features/warehouse/locations/BinScanField";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { PutawayTaskActions } from "@/features/warehouse/putaway/PutawayTaskActions";
import type { ResolvedLocation } from "@/features/warehouse/locations/useResolveLocationIdentity";

interface Task {
  id: string;
  state: string;
  quantity: number | null;
  lot_number: string | null;
  warehouse_id: string | null;
  row_version: number;
  destination_location_id: string | null;

  source_loc: { code: string | null } | null;
  dest_loc: { code: string | null } | null;
  product: { sku: string | null; name: string | null } | null;
}

interface Suggestion {
  location_id: string;
  rank: number;
  reason: string | null;
  strategy: string | null;
  feasible_qty: number | null;
  location: { code: string | null } | null;
}

export default function MobilePutaway() {
  const { id } = useParams();
  const nav = useNavigate();
  const [binConfirmed, setBinConfirmed] = useState(false);
  const [deviated, setDeviated] = useState(false);
  const [scanned, setScanned] = useState<ResolvedLocation | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: task, isLoading } = useQuery({
    queryKey: ["wm-putaway-task", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select(
          "id, state, quantity, lot_number, warehouse_id, row_version, destination_location_id, source_loc:source_location_id(code), dest_loc:destination_location_id(code), product:product_id(sku, name)",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Task | null;
    },
  });

  const { data: suggestions } = useQuery({
    queryKey: ["wm-putaway-suggestions", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_putaway_suggestions")
        .select("location_id, rank, reason, strategy, feasible_qty, location:location_id(code)")
        .eq("task_id", id!)
        .order("rank");
      if (error) throw error;
      return (data ?? []) as unknown as Suggestion[];
    },
    enabled: !!id,
  });

  const submit = async () => {
    if (!task) return;
    if (!task.destination_location_id) {
      toast.error("Task has no destination bin");
      return;
    }
    if (!binConfirmed) {
      toast.error(`Scan ${task.dest_loc?.code ?? "the destination bin"} first`);
      return;
    }
    if (deviated && reason.trim().length < 3) {
      toast.error("Give a reason for storing in a different bin");
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue("complete_putaway_task", {
        p_task_id: task.id,
        p_location_id: scanned?.location_id ?? task.destination_location_id,
        p_override_reason: deviated ? reason.trim() : null,
      });
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

  const done = task.state === "completed";
  return (
    <MobileWarehouseLayout
      title="Put-away"
      back="/wm"
      scanLabel="Scan destination bin"
      bottomBar={
        <Button className="w-full h-12" size="lg" disabled={busy || done || !binConfirmed} onClick={submit}>
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
        <BinScanField
          label="Scan destination bin"
          intent="putaway.bin"
          expectedLocationId={task.destination_location_id}
          expectedCode={task.dest_loc?.code ?? null}
          warehouseId={task.warehouse_id}
          disabled={done}
          allowDeviation
          onDeviationChange={setDeviated}
          onResolvedLocation={setScanned}
          onConfirmedChange={setBinConfirmed}
        />

        {deviated && (
          <div className="space-y-1.5">
            <Label htmlFor="putaway-reason">Why a different bin?</Label>
            <Textarea
              id="putaway-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. suggested bin full, damaged rack, blocked aisle"
              rows={2}
            />
          </div>
        )}

        {suggestions && suggestions.length > 1 && (
          <div className="rounded border p-3">
            <div className="mb-1.5 text-xs text-muted-foreground">Alternative bins</div>
            <ul className="space-y-1 text-sm">
              {suggestions.slice(1).map((s) => (
                <li key={s.location_id} className="flex items-center justify-between gap-2">
                  <span className="font-mono">{s.location?.code ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.reason ?? s.strategy ?? ""}
                    {s.feasible_qty != null ? ` · fits ${s.feasible_qty}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!done && (
          <div className="flex flex-wrap gap-1 rounded border p-2">
            <PutawayTaskActions
              task={{
                id: task.id,
                warehouse_id: task.warehouse_id ?? "",
                quantity: task.quantity,
                destination_location_id: task.destination_location_id,
                row_version: task.row_version,
              }}
            />
          </div>
        )}
      </div>
    </MobileWarehouseLayout>
  );
}
