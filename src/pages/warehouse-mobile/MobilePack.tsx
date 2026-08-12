/**
 * Mobile pack — operator-side counterpart to `PackStation.tsx` (desktop).
 *
 * A pack task groups all pick lines of one sales order that need to be
 * boxed. On mobile we present a task-scoped workspace:
 *
 *   1. List open cartons for the task's sales order.
 *   2. Open a new carton (auto-suggests packaging via `suggest_packaging`,
 *      the geometry-aware Packaging Master engine — ADR 0105 — never the
 *      legacy volume-only `suggest_carton`).

 *   3. Seal an open carton (optional weight input).
 *   4. Complete the pack task.
 *
 * Every RPC is routed through `enqueue()` — Phase 13 guard.
 * We never touch `wms_pack_cartons` directly; state transitions are
 * strictly RPC-driven, exactly like the desktop station.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { EntityScanField } from "@/features/warehouse/scanning/EntityScanField";
import { entityCodeEquals } from "@/features/warehouse/scanning/wmsEntityScan";
import {
  packagingFailureMessage,
  type PackagingSuggestion,
} from "@/features/warehouse/packaging/packagingEngine";
import { PackagePlus, Package, CheckCircle2 } from "lucide-react";


interface PackTask {
  id: string;
  state: string;
  business_id: string | null;
  wave_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface WaveLine {
  id: string;
  sales_order_id: string | null;
  product_id: string;
  quantity_picked: number | null;
  quantity_packed: number | null;
  packed_carton_id: string | null;
  product: { sku: string | null; name: string | null } | null;
}

interface Carton {
  id: string;
  sealed_at: string | null;
  weight_kg: number | null;
  sales_order_id: string | null;
  shipment_lpn: { code: string | null } | null;
  packaging_type: { code: string | null; name: string | null } | null;
}

export default function MobilePack() {
  const { packId } = useParams<{ packId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [weightKg, setWeightKg] = useState("");

  const { data: task, isLoading } = useQuery({
    queryKey: ["wm-pack-task", packId],
    enabled: !!packId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, state, business_id, metadata")
        .eq("id", packId!)
        .eq("task_type", "pack")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const md = (data.metadata ?? {}) as Record<string, unknown>;
      return { ...data, wave_id: (md.wave_id as string) ?? null } as PackTask;
    },
  });

  const waveId = task?.wave_id ?? null;
  const salesOrderId = (task?.metadata as Record<string, unknown> | undefined)?.sales_order_id as string | undefined;

  const { data: lines } = useQuery({
    queryKey: ["wm-pack-lines", waveId, salesOrderId],
    enabled: !!waveId && !!salesOrderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_wave_lines")
        .select(
          // Widened to `string` so the nested relation is not parsed at the
          // type level (TS2589); the row shape is pinned by the cast below.
          "id, sales_order_id, product_id, quantity_picked, quantity_packed, packed_carton_id, product:product_id(sku, name)" as string,
        )

        .eq("wave_id", waveId!)
        .eq("sales_order_id", salesOrderId!);
      if (error) throw error;
      return (data ?? []) as unknown as WaveLine[];
    },
  });

  const { data: cartons } = useQuery({
    queryKey: ["wm-pack-cartons", waveId, salesOrderId],
    enabled: !!waveId && !!salesOrderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pack_cartons")
        .select("id, sealed_at, weight_kg, sales_order_id, shipment_lpn:shipment_lpn_id(code), packaging_type:packaging_type_id(code, name)")
        .eq("wave_id", waveId!)
        .eq("sales_order_id", salesOrderId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as Carton[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wm-pack-cartons", waveId, salesOrderId] });
    qc.invalidateQueries({ queryKey: ["wm-pack-lines", waveId, salesOrderId] });
    qc.invalidateQueries({ queryKey: ["wm-pack-task", packId] });
  };

  const remaining = useMemo(
    () => (lines ?? []).filter((l) => !l.packed_carton_id),
    [lines],
  );
  const openCartons = useMemo(
    () => (cartons ?? []).filter((c) => !c.sealed_at),
    [cartons],
  );

  const openCarton = async () => {
    if (!task || !salesOrderId || busy) return;
    setBusy(true);
    try {
      // 1. Ask the Packaging Master engine (geometry + weight + carrier aware).
      let suggestedTypeId: string | null = null;
      let suggestedCode: string | null = null;
      let failureReason: string | null = null;
      if (task.business_id && remaining.length > 0) {
        const sug = await enqueue<PackagingSuggestion | null>("suggest_packaging", {
          p_business_id: task.business_id,
          p_lines: remaining.map((l) => ({
            product_id: l.product_id,
            quantity: (l.quantity_picked ?? 0) - (l.quantity_packed ?? 0),
          })),
          p_options: { include_restricted: false },
        });
        if (!sug.queued && sug.data) {
          if (sug.data.ok && sug.data.recommended) {
            suggestedTypeId = sug.data.recommended.packaging_type_id;
            suggestedCode = sug.data.recommended.code;
          } else {
            failureReason = sug.data.reason ?? "no_packaging_matches_constraints";
          }
        }
      }
      // 2. Open the carton. The replay dispatcher wraps the scalar uuid that
      //    `open_pack_carton` returns as `{ carton_id }` — mobile previously
      //    read the envelope as a bare string, so it never stamped packaging.
      const openRes = await enqueue<{ carton_id?: string } | null>("open_pack_carton", {
        p_wave_id: waveId!,
        p_sales_order_id: salesOrderId,
      });
      const cartonId = openRes.data?.carton_id ?? null;
      if (openRes.queued) {
        toast.success("Queued (offline)");
      } else {
        toast.success(suggestedCode ? `Carton opened · ${suggestedCode}` : "Carton opened");
        if (failureReason) toast.warning(packagingFailureMessage(failureReason));
        // 3. Stamp the suggested packaging (tare-safe, idempotent server-side).
        if (cartonId && suggestedTypeId) {
          await enqueue("assign_packaging_to_pack", {
            p_carton_id: cartonId,
            p_packaging_type_id: suggestedTypeId,
          });
        }
      }


      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Open failed");
    } finally {
      setBusy(false);
    }
  };

  const sealCarton = async (cartonId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await enqueue("seal_pack_carton", {
        p_carton_id: cartonId,
        p_weight_kg: weightKg ? Number(weightKg) : null,
        p_dims: null,
      });
      toast.success(r.queued ? "Queued (offline)" : "Carton sealed");
      setWeightKg("");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Seal failed");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Seal by scanning the carton's own label. Tapping "Seal" on a list row
   * works for a single-carton task, but a packer working a wall of open
   * cartons must be able to scan the one in their hands — the same intent
   * engine that drives every other RF prompt.
   */
  const sealByScan = useCallback(
    async (code: string) => {
      const match = (cartons ?? []).find(
        (c) => entityCodeEquals(c.shipment_lpn?.code, code) || entityCodeEquals(c.id, code),
      );
      if (!match) return { ok: false, message: `${code} is not a carton on this pack task.` };
      if (match.sealed_at) return { ok: false, message: `${code} is already sealed.` };
      await sealCarton(match.id);
      return { ok: true, message: `${code} sealed` };
    },
    // sealCarton is recreated per render but closes only over stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cartons],
  );

  const completePack = async () => {
    if (!task || busy) return;
    setBusy(true);
    try {
      const r = await enqueue("complete_pack_task", { p_task_id: task.id });
      toast.success(r.queued ? "Queued (offline)" : "Pack complete");
      nav("/wm");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Complete failed");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return <MobileWarehouseLayout title="Pack" back="/wm">Loading…</MobileWarehouseLayout>;
  }
  if (!task) {
    return <MobileWarehouseLayout title="Pack" back="/wm">Task not found.</MobileWarehouseLayout>;
  }

  const done = task.state === "completed";
  const canComplete = !done && remaining.length === 0 && openCartons.length === 0;

  return (
    <MobileWarehouseLayout
      title="Pack"
      back="/wm"
      scanLabel="Scan item or carton label"
      scanContinuous

      bottomBar={
        <Button
          className="w-full h-12"
          size="lg"
          disabled={busy || done || !canComplete}
          onClick={completePack}
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          {done ? "Completed" : canComplete ? "Complete pack" : `Seal cartons first (${openCartons.length})`}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded border p-3">
          <div className="text-xs text-muted-foreground">Task</div>
          <div className="font-mono">{task.id.slice(0, 8)}</div>
          <div className="text-xs mt-1">State: {task.state}</div>
        </div>

        <div className="rounded border p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Remaining to pack</div>
              <div className="text-lg font-semibold">{remaining.length} line(s)</div>
            </div>
            <Button
              size="sm"
              onClick={openCarton}
              disabled={busy || done || remaining.length === 0}
            >
              <PackagePlus className="h-4 w-4 mr-1" /> Open carton
            </Button>
          </div>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            Cartons · {(cartons ?? []).length}
          </h2>
          {openCartons.length > 0 && !done && (
            <div className="mb-3">
              <EntityScanField
                label="Scan carton to seal"
                intent="pack.carton"
                entity="carton"
                disabled={busy}
                onResolve={sealByScan}
              />
            </div>
          )}
          {(cartons ?? []).length === 0 ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No cartons opened yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {(cartons ?? []).map((c) => (
                <li key={c.id} className="rounded border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Package className="h-5 w-5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <div className="font-mono text-sm truncate">
                          {c.id.slice(0, 8)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.packaging_type?.code ?? "no packaging"}
                          {c.sealed_at ? " · sealed" : " · open"}
                          {c.weight_kg != null ? ` · ${c.weight_kg}kg` : ""}
                        </div>
                      </div>
                    </div>
                    {!c.sealed_at && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => sealCarton(c.id)}
                        disabled={busy}
                      >
                        Seal
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {openCartons.length > 0 && (
          <div>
            <Label>Weight (kg, optional — applied to the next seal)</Label>
            <Input
              inputMode="decimal"
              value={weightKg}
              onChange={(e) => setWeightKg(e.target.value)}
              placeholder="e.g. 4.2"
              className="h-12 text-lg font-mono"
            />
          </div>
        )}
      </div>
    </MobileWarehouseLayout>
  );
}
