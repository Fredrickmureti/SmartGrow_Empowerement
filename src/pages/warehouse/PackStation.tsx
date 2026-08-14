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
import {
  suggestPackaging,
  assignPackagingToPack,
  packagingFailureMessage,
} from "@/features/warehouse/packaging/packagingEngine";
import { CartonSsccLabelButton } from "@/features/warehouse/packaging/CartonSsccLabelButton";
import { PackWaveLabelButton } from "@/features/warehouse/packaging/PackWaveLabelButton";
import {
  resolveCartonScan,
  cartonScanFailureMessage,
} from "@/features/warehouse/packaging/handlingUnitPackaging";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import { usePackScale } from "@/features/warehouse/packaging/usePackScale";
import { useWarehouseQtyFormatter, WarehouseQty } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";
import { Scale, RotateCcw } from "lucide-react";


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
  packaging_type_id: string | null;
  shipment_lpn: { code: string } | null;
  packaging_type: { code: string; name: string; packaging_class: string } | null;
}

interface PackagingType {
  id: string;
  code: string;
  name: string;
  packaging_class: string;
  outer_length_cm: number | null;
  outer_width_cm: number | null;
  outer_height_cm: number | null;
  max_weight_kg: number | null;
  lifecycle_status: string;
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

  // ADR 0105 — the Packaging Master replaces the legacy carton catalogue.
  const { data: packagingTypes } = useQuery({
    queryKey: ["wms-packaging-types", wave?.business_id],
    enabled: !!wave?.business_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_packaging_types")
        .select(
          "id, code, name, packaging_class, outer_length_cm, outer_width_cm, outer_height_cm, max_weight_kg, lifecycle_status",
        )
        .eq("business_id", wave!.business_id!)
        .in("lifecycle_status", ["active", "restricted"])
        .order("code");
      if (error) throw error;
      return (data ?? []) as PackagingType[];
    },
  });


  const { data: lines } = useQuery({
    queryKey: ["wms-pick-wave-lines", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_wave_lines")
        .select(
          // `as string` keeps supabase-js from parsing this nested select at
          // the type level (TS2589); the cast below pins the row shape.
          "id, quantity_ordered, quantity_picked, quantity_packed, lot_number, product_id, sales_order_id, packed_carton_id, product:product_id(name, sku)" as string,
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
          "id, wave_id, sales_order_id, shipment_lpn_id, weight_kg, length_cm, width_cm, height_cm, sealed_at, packaging_type_id, shipment_lpn:shipment_lpn_id(code), packaging_type:packaging_type_id(code, name, packaging_class)",
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
      // 1. Ask the Packaging Master engine (geometry-aware) what fits.
      const remaining = (lines ?? []).filter(
        (l) => l.sales_order_id === sales_order_id && !l.packed_carton_id,
      );
      let suggestedTypeId: string | null = null;
      let suggestedCode: string | null = null;
      let failureReason: string | null = null;
      if (wave?.business_id && remaining.length > 0) {
        try {
          const suggestion = await suggestPackaging(
            wave.business_id,
            remaining.map((l) => ({
              product_id: l.product_id,
              quantity: (l.quantity_picked ?? 0) - (l.quantity_packed ?? 0),
            })),
            { warehouse_id: wave.warehouse_id ?? null, include_restricted: false },
          );
          if (suggestion.ok && suggestion.recommended) {
            suggestedTypeId = suggestion.recommended.packaging_type_id;
            suggestedCode = suggestion.recommended.code;
          } else {
            failureReason = suggestion.reason ?? "no_packaging_matches_constraints";
          }
        } catch (sErr) {
          console.warn("suggest_packaging failed", sErr);
        }
      }
      // 2. Open the carton. The replay dispatcher wraps the scalar uuid that
      //    `open_pack_carton` returns as `{ carton_id }`.
      const { data: opened } = await replayGuardedCall<{ carton_id?: string } | null>(
        "open_pack_carton",
        { p_wave_id: waveId!, p_sales_order_id: sales_order_id },
      );
      const cartonId = opened?.carton_id ?? null;


      // 3. Stamp the suggested packaging (best effort — never fail the open)
      if (cartonId && suggestedTypeId) {
        try {
          await assignPackagingToPack(cartonId, suggestedTypeId);
        } catch (aErr) {
          console.warn("assign_packaging_to_pack failed", aErr);
        }
      }
      return { cartonId, suggestedCode, failureReason };
    },
    onSuccess: ({ suggestedCode, failureReason }) => {
      toast.success(suggestedCode ? `Carton opened · suggested ${suggestedCode}` : "Carton opened");
      if (failureReason) toast.warning(packagingFailureMessage(failureReason));
      invalidateAll();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Open failed"),
  });

  const assignCartonType = useMutation({
    mutationFn: async (v: { carton_id: string; packaging_type_id: string }) => {
      await assignPackagingToPack(v.carton_id, v.packaging_type_id);
    },
    onSuccess: () => { toast.success("Packaging updated"); invalidateAll(); },
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

  // Phase 2.4 — unit truth: every packed/picked figure renders through the
  // canonical pack/base-UoM formatter, never a naked base integer.
  const lineProductIds = useMemo(
    () => (lines ?? []).map((l) => l.product_id),
    [lines],
  );
  const baseLabels = useProductBaseUomLabels(lineProductIds);
  const qtyFmt = useWarehouseQtyFormatter(lineProductIds, baseLabels);

  const [sealDialog, setSealDialog] = useState<{ carton_id: string } | null>(null);
  const [weightKg, setWeightKg] = useState("");
  const [lenCm, setLenCm] = useState("");
  const [widCm, setWidCm] = useState("");
  const [hgtCm, setHgtCm] = useState("");

  // Phase 6 — the sealed weight comes off the bound scale via the hardware
  // command router, not the operator's fingers. Manual entry stays available
  // for sites without a scale.
  const scale = usePackScale();
  const captureWeight = async () => {
    const w = await scale.read();
    if (!w) {
      toast.error(scale.error ?? "Scale read failed");
      return;
    }
    setWeightKg(String(w.kg));
    if (!w.stable) toast.warning("Scale reading is not stable — re-weigh before sealing");
    else toast.success(`Captured ${w.kg} kg`);
  };

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

  // ADR 0105 §8 — scanning a carton label (SSCC-18, GS1 (00) element string or
  // the plate code) resolves the handling unit server-side and focuses that
  // carton: open → seal dialog, sealed → operator feedback. The client never
  // parses an SSCC itself.
  const [scannedCartonId, setScannedCartonId] = useState<string | null>(null);
  const cartonScan = useWmsScanIntent({
    intent: "pack.carton",
    onScan: (payload) => {
      const businessId = wave?.business_id;
      if (!businessId) return;
      void (async () => {
        try {
          const res = await resolveCartonScan(businessId, payload.raw || payload.resolveCode);
          if (!res.ok) {
            cartonScan.reportUnexpected(payload.raw, cartonScanFailureMessage(res.reason));
            return;
          }
          const match = (cartons ?? []).find(
            (c) => c.id === res.carton?.id || c.shipment_lpn_id === res.lpn?.id,
          );
          if (!match) {
            cartonScan.reportUnexpected(payload.raw, "That handling unit is not part of this wave");
            return;
          }
          setScannedCartonId(match.id);
          if (match.sealed_at) {
            toast.info(
              `${res.lpn?.code ?? "Carton"} is already sealed${res.packaging ? ` · ${res.packaging.code}` : ""}`,
            );
          } else {
            setSealDialog({ carton_id: match.id });
          }
        } catch (err) {
          cartonScan.reportUnexpected(
            payload.raw,
            err instanceof Error ? err.message : "Carton scan failed",
          );
        }
      })();
    },
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
          const canComplete = task && task.state !== "completed" && allPacked && allSealed;

          return (
            <Section
              key={soId}
              title={`Sales order ${soId.slice(0, 8)}`}
              actions={
                <div className="flex items-center gap-2">
                  <StatusBadge tone={task?.state === "completed" ? "success" : "info"}>
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
              <div className="min-w-0 grid gap-3 @4xl/page:grid-cols-2">
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
                              <td className="p-2 text-right font-mono">
                                <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.quantity_picked} />
                              </td>
                              <td className="p-2 text-right font-mono">
                                <WarehouseQty fmt={qtyFmt} productId={l.product_id} baseQty={l.quantity_packed} />
                              </td>
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
                  <CardHeader className="p-3 pb-0 flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-sm">Cartons</CardTitle>
                    <PackWaveLabelButton
                      businessId={wave.business_id ?? null}
                      waveId={waveId!}
                      warehouseId={wave.warehouse_id}
                      sealedCount={(cartons ?? []).filter((c) => !!c.sealed_at).length}
                    />
                  </CardHeader>

                  <CardContent className="p-3 space-y-2">
                    {soCartons.length === 0 && (
                      <p className="text-sm text-muted-foreground">No cartons yet. Open one to start packing.</p>
                    )}
                    {soCartons.map((c) => (
                      <div
                        key={c.id}
                        className={`flex items-center justify-between border rounded p-2 gap-2 ${
                          scannedCartonId === c.id ? "border-primary bg-primary/5" : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-sm truncate">{c.shipment_lpn?.code ?? c.id.slice(0, 8)}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.sealed_at ? `sealed · ${c.weight_kg ?? "?"}kg` : "open"}
                            {c.packaging_type ? ` · ${c.packaging_type.code}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!c.sealed_at && (
                            <select
                              className="border rounded px-2 py-1 text-xs bg-background"
                              value={c.packaging_type_id ?? ""}
                              disabled={assignCartonType.isPending}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v) assignCartonType.mutate({ carton_id: c.id, packaging_type_id: v });
                              }}
                            >
                              <option value="">packaging…</option>
                              {(packagingTypes ?? []).map((t) => (
                                <option key={t.id} value={t.id}>{t.code} — {t.name}</option>
                              ))}
                            </select>
                          )}
                          {!c.sealed_at && (
                            <Button size="sm" variant="outline" onClick={() => setSealDialog({ carton_id: c.id })}>
                              <Lock className="h-4 w-4 mr-1" /> Seal
                            </Button>
                          )}
                          {c.sealed_at && wave.business_id && (
                            <CartonSsccLabelButton
                              businessId={wave.business_id}
                              cartonId={c.id}
                              packagingTypeId={c.packaging_type_id}
                              warehouseId={wave.warehouse_id}
                              packagingName={c.packaging_type?.name ?? null}
                              orderNumber={c.sales_order_id.slice(0, 8)}
                              cartonSequence={c.shipment_lpn?.code ?? c.id.slice(0, 8)}
                              grossWeightKg={c.weight_kg}
                            />
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
          <div className="min-w-0 grid grid-cols-2 gap-3">
            <div className="min-w-0 col-span-2">
              <Label htmlFor="wt">Weight (kg)</Label>
              <div className="flex items-center gap-2">
                <Input id="wt" type="number" step="0.01" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
                <Button type="button" variant="outline" size="sm" disabled={scale.busy} onClick={() => void captureWeight()}>
                  <Scale className="h-4 w-4 mr-1" /> Read scale
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={scale.busy} onClick={() => void scale.tare()} aria-label="Tare scale">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
              {scale.reading && (
                <p className="text-xs text-muted-foreground mt-1">
                  Scale: {scale.reading.kg} kg · {scale.reading.stable ? "stable" : "unstable"}
                </p>
              )}
              {scale.error && <p className="text-xs text-destructive mt-1">{scale.error}</p>}
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
