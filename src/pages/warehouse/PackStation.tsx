/**
 * PackStation — multi-carton, per-sales-order packing for a picked wave.
 *
 * Phase 4b (ADR 0082). Real warehouses ship customer orders in cartons,
 * not "one LPN per wave". After a wave is picked, `complete_pick_task`
 * spawns one `pack` task per distinct sales order. This page walks the
 * operator through:
 *
 *   1. Open one or more cartons per SO (`open_pack_carton` → shipment LPN).
 *   2. Assign each picked wave line to an open carton
 *      (`assign_line_to_carton`).
 *   3. Seal the carton with weight + LxWxH (`seal_pack_carton`).
 *   4. Complete the pack task once every picked line for that SO is in a
 *      sealed carton (`complete_pack_task`). The wave flips to `packed`
 *      only when every pack task is done.
 *
 * All state transitions go through sanctioned RPCs — no direct writes to
 * `wms_pack_cartons.sealed_at` or `wms_pick_waves.state` from the client.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import { useSealCarton } from "@/features/warehouse/aggregates/useDomainOperations";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, PackageCheck, PackagePlus, Lock, Check } from "lucide-react";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";

interface WaveLine {
  id: string;
  quantity_ordered: number;
  quantity_picked: number;
  quantity_packed: number;
  lot_number: string | null;
  product_id: string;
  sales_order_id: string | null;
  packed_carton_id: string | null;
  product: { name: string; sku: string | null } | null;
}

interface PackTask {
  id: string;
  state: string;
  metadata: { wave_id?: string; sales_order_id?: string } | null;
}

interface Carton {
  id: string;
  wave_id: string;
  sales_order_id: string;
  shipment_lpn_id: string | null;
  weight_kg: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  sealed_at: string | null;
  carton_type_id: string | null;
  shipment_lpn: { code: string } | null;
  carton_type: { code: string; name: string } | null;
}

interface CartonType {
  id: string;
  code: string;
  name: string;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  max_weight_kg: number | null;
  is_active: boolean;
}

export default function PackStation() {
  const { waveId } = useParams<{ waveId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: wave, isLoading } = useQuery({
    queryKey: ["wms-pick-wave", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select("id, wave_number, state, warehouse_id, business_id, released_at, completed_at")
        .eq("id", waveId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: cartonTypes } = useQuery({
    queryKey: ["wms-carton-types", wave?.business_id],
    enabled: !!wave?.business_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_carton_types")
        .select("id, code, name, length_cm, width_cm, height_cm, max_weight_kg, is_active")
        .eq("business_id", wave!.business_id!)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as CartonType[];
    },
  });

  const { data: lines } = useQuery({
    queryKey: ["wms-pick-wave-lines", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_wave_lines")
        .select(
          "id, quantity_ordered, quantity_picked, quantity_packed, lot_number, product_id, sales_order_id, packed_carton_id, product:product_id(name, sku)",
        )
        .eq("wave_id", waveId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as WaveLine[];
    },
  });

  const { data: cartons } = useQuery({
    queryKey: ["wms-pack-cartons", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pack_cartons")
        .select(
          "id, wave_id, sales_order_id, shipment_lpn_id, weight_kg, length_cm, width_cm, height_cm, sealed_at, carton_type_id, shipment_lpn:shipment_lpn_id(code), carton_type:carton_type_id(code, name)",
        )
        .eq("wave_id", waveId!)
        .order("opened_at");
      if (error) throw error;
      return (data ?? []) as unknown as Carton[];
    },
  });

  const { data: packTasks } = useQuery({
    queryKey: ["wms-pack-tasks", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, state, metadata")
        .eq("task_type", "pack")
        .contains("metadata", { wave_id: waveId! });
      if (error) throw error;
      return (data ?? []) as unknown as PackTask[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["wms-pick-wave", waveId] });
    qc.invalidateQueries({ queryKey: ["wms-pick-wave-lines", waveId] });
    qc.invalidateQueries({ queryKey: ["wms-pack-cartons", waveId] });
    qc.invalidateQueries({ queryKey: ["wms-pack-tasks", waveId] });
    qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
  };

  const openCarton = useMutation({
    mutationFn: async (sales_order_id: string) => {
      // 1. Ask the engine which carton type fits the remaining unpacked lines
      const remaining = (lines ?? []).filter(
        (l) => l.sales_order_id === sales_order_id && !l.packed_carton_id,
      );
      let suggestedTypeId: string | null = null;
      let suggestedCode: string | null = null;
      if (wave?.business_id && remaining.length > 0) {
        const { data: suggestion } = await supabase.rpc("suggest_carton", {
          p_business_id: wave.business_id,
          p_product_ids: remaining.map((l) => l.product_id),
          p_quantities: remaining.map((l) => (l.quantity_picked ?? 0) - (l.quantity_packed ?? 0)),
        });
        // RPC returns a wms_carton_types row (or null)
        const row = suggestion as { id?: string; code?: string } | null;
        if (row && row.id) {
          suggestedTypeId = row.id;
          suggestedCode = row.code ?? null;
        }
      }
      // 2. Open the carton
      const { data: opened } = await replayGuardedCall<{ carton_id?: string } | null>(
        "open_pack_carton",
        { p_wave_id: waveId!, p_sales_order_id: sales_order_id },
      );
      const cartonId = opened?.carton_id ?? null;
      // 3. Stamp the suggested carton type (best effort — do not fail the open)
      if (cartonId && suggestedTypeId) {
        try {
          await replayGuardedCall("assign_carton_to_pack", {
            p_carton_id: cartonId,
            p_carton_type_id: suggestedTypeId,
          });
        } catch (aErr) {
          console.warn("assign_carton_to_pack failed", aErr);
        }
      }
      return { cartonId, suggestedCode };
    },
    onSuccess: ({ suggestedCode }) => {
      toast.success(suggestedCode ? `Carton opened · suggested ${suggestedCode}` : "Carton opened");
      invalidateAll();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Open failed"),
  });

  const assignCartonType = useMutation({
    mutationFn: async (v: { carton_id: string; carton_type_id: string }) => {
      await replayGuardedCall("assign_carton_to_pack", {
        p_carton_id: v.carton_id,
        p_carton_type_id: v.carton_type_id,
      });
    },
    onSuccess: () => { toast.success("Carton type updated"); invalidateAll(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  const assignLine = useMutation({
    mutationFn: async (v: { carton_id: string; wave_line_id: string; qty: number }) => {
      await replayGuardedCall("assign_line_to_carton", {
        p_carton_id: v.carton_id,
        p_wave_line_id: v.wave_line_id,
        p_qty: v.qty,
      });
    },
    onSuccess: () => invalidateAll(),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Assign failed"),
  });

  const [sealDialog, setSealDialog] = useState<{ carton_id: string } | null>(null);
  const [weightKg, setWeightKg] = useState("");
  const [lenCm, setLenCm] = useState("");
  const [widCm, setWidCm] = useState("");
  const [hgtCm, setHgtCm] = useState("");

  const sealMut = useSealCarton(waveId);
  const sealCarton = {
    isPending: sealMut.isPending,
    mutate: (v: { carton_id: string }) => {
      sealMut.mutate(
        {
          cartonId: v.carton_id,
          weightKg: weightKg ? Number(weightKg) : null,
          dims: (lenCm || widCm || hgtCm)
            ? { length_cm: Number(lenCm) || null, width_cm: Number(widCm) || null, height_cm: Number(hgtCm) || null }
            : null,
        },
        {
          onSuccess: () => {
            toast.success("Carton sealed");
            setSealDialog(null); setWeightKg(""); setLenCm(""); setWidCm(""); setHgtCm("");
            invalidateAll();
          },
        },
      );
    },
  };

  const completePack = useMutation({
    mutationFn: async (task_id: string) => {
      await replayGuardedCall("complete_pack_task", { p_task_id: task_id });
    },
    onSuccess: () => {
      toast.success("Pack task complete");
      invalidateAll();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Complete failed"),
  });

  const salesOrders = useMemo(() => {
    const ids = new Set<string>();
    (lines ?? []).forEach((l) => { if (l.sales_order_id) ids.add(l.sales_order_id); });
    return Array.from(ids);
  }, [lines]);

  if (isLoading) return <LoadingState />;
  if (!wave) {
    return (
      <EmptyState
        icon={PackageCheck}
        title="Wave not found"
        description="It may have been deleted or you do not have access."
        action={<Button asChild><Link to="/warehouse-app/waves">Back to waves</Link></Button>}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{wave.wave_number} — pack</span>}
        description={`State: ${wave.state}`}
        actions={
          <Button variant="outline" asChild>
            <Link to="/warehouse-app/waves"><ArrowLeft className="h-4 w-4 mr-2" /> Waves</Link>
          </Button>
        }
      />
      <PageBody>
        {salesOrders.length === 0 && (
          <EmptyState
            icon={PackageCheck}
            title="Nothing to pack"
            description="This wave has no sales-order lines."
          />
        )}

        {salesOrders.map((soId) => {
          const soLines = (lines ?? []).filter((l) => l.sales_order_id === soId);
          const soCartons = (cartons ?? []).filter((c) => c.sales_order_id === soId);
          const task = (packTasks ?? []).find((t) => t.metadata?.sales_order_id === soId);
          const allPacked = soLines.every((l) => (l.quantity_picked ?? 0) === 0 || l.packed_carton_id);
          const allSealed = soCartons.length > 0 && soCartons.every((c) => c.sealed_at);
          const canComplete = task && task.state !== "done" && allPacked && allSealed;

          return (
            <Section
              key={soId}
              title={`Sales order ${soId.slice(0, 8)}`}
              actions={
                <div className="flex items-center gap-2">
                  <StatusBadge tone={task?.state === "done" ? "success" : "info"}>
                    {task?.state ?? "no task"}
                  </StatusBadge>
                  <Button size="sm" variant="outline" onClick={() => openCarton.mutate(soId)} disabled={openCarton.isPending}>
                    <PackagePlus className="h-4 w-4 mr-1" /> Open carton
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canComplete || completePack.isPending}
                    onClick={() => task && completePack.mutate(task.id)}
                  >
                    <Check className="h-4 w-4 mr-1" /> Complete pack
                  </Button>
                </div>
              }
            >
              <div className="grid gap-3 lg:grid-cols-2">
                <Card>
                  <CardHeader className="p-3 pb-0"><CardTitle className="text-sm">Picked lines</CardTitle></CardHeader>
                  <CardContent className="p-0">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr className="text-left">
                          <th className="p-2">Product</th>
                          <th className="p-2 text-right">Picked</th>
                          <th className="p-2 text-right">Packed</th>
                          <th className="p-2">Assign</th>
                        </tr>
                      </thead>
                      <tbody>
                        {soLines.map((l) => {
                          const remaining = (l.quantity_picked ?? 0) - (l.quantity_packed ?? 0);
                          return (
                            <tr key={l.id} className="border-t">
                              <td className="p-2">
                                {l.product?.name ?? l.product_id}
                                {l.lot_number ? <div className="text-xs text-muted-foreground">Lot {l.lot_number}</div> : null}
                              </td>
                              <td className="p-2 text-right font-mono">{Number(l.quantity_picked).toFixed(2)}</td>
                              <td className="p-2 text-right font-mono">{Number(l.quantity_packed).toFixed(2)}</td>
                              <td className="p-2">
                                {remaining > 0 ? (
                                  <select
                                    className="border rounded px-2 py-1 text-xs bg-background"
                                    defaultValue=""
                                    onChange={(e) => {
                                      const cartonId = e.target.value;
                                      if (!cartonId) return;
                                      assignLine.mutate({ carton_id: cartonId, wave_line_id: l.id, qty: remaining });
                                      e.currentTarget.value = "";
                                    }}
                                  >
                                    <option value="">→ carton</option>
                                    {soCartons.filter((c) => !c.sealed_at).map((c) => (
                                      <option key={c.id} value={c.id}>{c.shipment_lpn?.code ?? c.id.slice(0, 8)}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="text-xs text-muted-foreground">done</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="p-3 pb-0"><CardTitle className="text-sm">Cartons</CardTitle></CardHeader>
                  <CardContent className="p-3 space-y-2">
                    {soCartons.length === 0 && (
                      <p className="text-sm text-muted-foreground">No cartons yet. Open one to start packing.</p>
                    )}
                    {soCartons.map((c) => (
                      <div key={c.id} className="flex items-center justify-between border rounded p-2 gap-2">
                        <div className="min-w-0">
                          <div className="font-mono text-sm truncate">{c.shipment_lpn?.code ?? c.id.slice(0, 8)}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.sealed_at ? `sealed · ${c.weight_kg ?? "?"}kg` : "open"}
                            {c.carton_type ? ` · ${c.carton_type.code}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!c.sealed_at && (
                            <select
                              className="border rounded px-2 py-1 text-xs bg-background"
                              value={c.carton_type_id ?? ""}
                              disabled={assignCartonType.isPending}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v) assignCartonType.mutate({ carton_id: c.id, carton_type_id: v });
                              }}
                            >
                              <option value="">carton type…</option>
                              {(cartonTypes ?? []).map((t) => (
                                <option key={t.id} value={t.id}>{t.code} — {t.name}</option>
                              ))}
                            </select>
                          )}
                          {!c.sealed_at && (
                            <Button size="sm" variant="outline" onClick={() => setSealDialog({ carton_id: c.id })}>
                              <Lock className="h-4 w-4 mr-1" /> Seal
                            </Button>
                          )}
                          {c.sealed_at && c.shipment_lpn?.code && (
                            <>
                              <PrintLabelButton
                                label="Pallet"
                                size="sm"
                                variant="ghost"
                                templateKey="pallet_label"
                                workflow="receiving"
                                product={{
                                  id: c.id,
                                  name: `Pallet ${c.shipment_lpn.code}`,
                                  sku: c.shipment_lpn.code,
                                  barcode: null,
                                }}
                                sourceDocType="wms_pack_carton"
                                sourceDocId={c.id}
                                idempotencyKey={`pallet_label:${c.id}`}
                                extraVars={{ lpn_code: c.shipment_lpn.code }}
                              />
                              <PrintLabelButton
                                label="Ship"
                                size="sm"
                                variant="outline"
                                templateKey="shipping_label"
                                workflow="shipping"
                                product={{
                                  id: c.id,
                                  name: `Shipment ${c.shipment_lpn.code}`,
                                  sku: c.shipment_lpn.code,
                                  barcode: null,
                                }}
                                sourceDocType="wms_pack_carton"
                                sourceDocId={c.id}
                                idempotencyKey={`shipping_label:${c.id}`}
                                extraVars={{
                                  lpn_code: c.shipment_lpn.code,
                                  weight_kg: c.weight_kg ?? "",
                                }}
                              />
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </Section>
          );
        })}
      </PageBody>

      <Dialog open={!!sealDialog} onOpenChange={(v) => !v && setSealDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Seal carton</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="wt">Weight (kg)</Label>
              <Input id="wt" type="number" step="0.01" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="l">Length (cm)</Label>
              <Input id="l" type="number" step="0.1" value={lenCm} onChange={(e) => setLenCm(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="w">Width (cm)</Label>
              <Input id="w" type="number" step="0.1" value={widCm} onChange={(e) => setWidCm(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="h">Height (cm)</Label>
              <Input id="h" type="number" step="0.1" value={hgtCm} onChange={(e) => setHgtCm(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSealDialog(null)}>Cancel</Button>
            <Button
              onClick={() => sealDialog && sealCarton.mutate({ carton_id: sealDialog.carton_id })}
              disabled={sealCarton.isPending}
            >
              <Lock className="h-4 w-4 mr-1" /> Seal carton
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {wave.state === "packed" && (
        <div className="p-4">
          <Button onClick={() => nav("/warehouse-app/waves")}>Back to waves</Button>
        </div>
      )}
    </>
  );
}
