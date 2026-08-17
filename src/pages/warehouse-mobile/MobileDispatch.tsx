/**
 * Mobile dispatch — scan carton LPNs onto a loading manifest, then close /
 * dispatch. Counterpart to desktop `LoadingBay.tsx`. Every state transition
 * is RPC-only through `enqueue()`:
 *
 *   load_carton_onto_manifest
 *   close_loading_manifest
 *   dispatch_loading_manifest
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toWmsFailure, wmsErrorToast } from "@/features/warehouse/errors/wmsRpcError";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { EntityScanField } from "@/features/warehouse/scanning/EntityScanField";
import { entityCodeEquals } from "@/features/warehouse/scanning/wmsEntityScan";
import { DispatchProofForm } from "@/features/warehouse/dispatch/DispatchProofForm";
import {
  dispatchProofArgs,
  type DispatchProofInput,
  type ManifestProofStatus,
} from "@/features/warehouse/aggregates/useDomainOperations";
import { Truck, PackageCheck } from "lucide-react";

interface Manifest {
  id: string;
  code: string;
  state: string;
  warehouse_id: string;
  planned_departure_at: string | null;
  dispatched_at: string | null;
  closed_at: string | null;
}

interface AvailableCarton {
  id: string;
  sealed_at: string | null;
  weight_kg: number | null;
  shipment_lpn: { code: string | null } | null;
}

interface LoadedRow {
  id: string;
  sequence: number;
  loaded_at: string;
  carton: { id: string; weight_kg: number | null; shipment_lpn_id: string | null } | null;
}

export default function MobileDispatch() {
  const { shipmentId } = useParams<{ shipmentId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Phase C — proof of dispatch. The *server* decides whether proof is
  // required and whether what was captured satisfies it (`wms_manifest_
  // proof_status`); the handheld never re-derives that rule. The capture
  // write goes through the offline queue so a driver in a dead zone can
  // still take custody evidence.
  const { data: proofStatus } = useQuery({
    queryKey: ["wm-manifest-proof", shipmentId],
    enabled: !!shipmentId,
    queryFn: async (): Promise<ManifestProofStatus | null> => {
      const { data, error } = await supabase.rpc("wms_manifest_proof_status", {
        p_manifest_id: shipmentId!,
      });
      if (error) throw error;
      return (data ?? null) as unknown as ManifestProofStatus | null;
    },
  });

  const { data: manifest, isLoading } = useQuery({
    queryKey: ["wm-manifest", shipmentId],
    enabled: !!shipmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_loading_manifests")
        .select("id, code, state, warehouse_id, planned_departure_at, dispatched_at, closed_at")
        .eq("id", shipmentId!)
        .maybeSingle();
      if (error) throw error;
      return data as Manifest | null;
    },
  });

  const { data: loaded } = useQuery({
    queryKey: ["wm-manifest-cartons", shipmentId],
    enabled: !!shipmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_manifest_cartons")
        .select("id, sequence, loaded_at, carton:carton_id(id, weight_kg, shipment_lpn_id)")
        .eq("manifest_id", shipmentId!)
        .order("sequence");
      if (error) throw error;
      return (data ?? []) as unknown as LoadedRow[];
    },
  });

  const { data: available } = useQuery({
    queryKey: ["wm-cartons-available", manifest?.warehouse_id],
    enabled: !!manifest?.warehouse_id && manifest?.state === "loading",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pack_cartons")
        .select("id, sealed_at, weight_kg, shipment_lpn:shipment_lpn_id(code)")
        .is("manifest_id", null)
        .not("sealed_at", "is", null)
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as AvailableCarton[];
    },
  });

  const loadedIds = useMemo(
    () => new Set((loaded ?? []).map((l) => l.carton?.id).filter(Boolean) as string[]),
    [loaded],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wm-manifest", shipmentId] });
    qc.invalidateQueries({ queryKey: ["wm-manifest-cartons", shipmentId] });
    qc.invalidateQueries({ queryKey: ["wm-cartons-available"] });
    qc.invalidateQueries({ queryKey: ["wm-manifest-proof", shipmentId] });
  };

  const captureProof = async (values: DispatchProofInput) => {
    if (!manifest || busy) return;
    setBusy(true);
    try {
      const r = await enqueue("wms_capture_dispatch_proof", dispatchProofArgs(manifest.id, values));
      toast.success(r.queued ? "Queued (offline)" : "Proof captured");
      invalidate();
    } catch (e) {
      toast.error(...wmsErrorToast(e, "Could not capture proof"));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Carton admission. The wrong-kind refusal (a product barcode scanned at
   * the carton prompt) is handled upstream by `EntityScanField`; here we
   * only answer "is this carton loadable onto THIS manifest?".
   */
  const loadCode = useCallback(
    async (code: string) => {
      if (busy || !manifest) return { ok: false, message: "Busy — wait for the last scan to finish." };
      const match = (available ?? []).find((c) => entityCodeEquals(c.shipment_lpn?.code, code));
      if (!match) {
        return { ok: false, message: `${code} is not a sealed carton waiting for this bay.` };
      }
      if (loadedIds.has(match.id)) {
        return { ok: false, message: `${code} is already on this manifest.` };
      }
      setBusy(true);
      try {
        const r = await enqueue("load_carton_onto_manifest", {
          p_manifest_id: manifest.id,
          p_carton_id: match.id,
        });
        invalidate();
        return { ok: true, message: r.queued ? `${code} queued (offline)` : `${code} loaded` };
      } catch (e) {
        return { ok: false, message: toWmsFailure(e, "Load failed").message };
      } finally {
        setBusy(false);
      }
    },
    // `invalidate` is a stable-enough closure over the query client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, manifest, available, loadedIds],
  );

  // Phase 3.7 §4 — translate WMS_SCAN_SHORTAGE into a plain
  // "load the remaining cartons first" message instead of the raw code.
  // We deliberately do NOT preview shortage via `supabase.rpc` here — the
  // Phase 13 mobile guard forbids direct RPCs on the RF shell, so the
  // enforcement RPC itself is the source of truth on close/dispatch.
  const reportFailure = (e: unknown, verb: "close" | "dispatch") => {
    const failure = toWmsFailure(e, verb === "close" ? "Close failed" : "Dispatch failed");
    if (failure.code === "WMS_SCAN_SHORTAGE") {
      toast.error(
        verb === "close"
          ? "Cannot close: sealed cartons are still on the floor."
          : "Cannot dispatch: sealed cartons are missing from this manifest.",
        { description: "Scan every sealed carton for this wave/SO onto the manifest first." },
      );
      return;
    }
    toast.error(failure.message, failure.description ? { description: failure.description } : {});
  };

  const close = async () => {
    if (!manifest || busy) return;
    setBusy(true);
    try {
      const r = await enqueue("close_loading_manifest", { p_manifest_id: manifest.id });
      toast.success(r.queued ? "Queued (offline)" : "Manifest closed");
      invalidate();
    } catch (e) {
      reportFailure(e, "close");
    } finally {
      setBusy(false);
    }
  };

  const dispatch = async () => {
    if (!manifest || busy) return;
    setBusy(true);
    try {
      const r = await enqueue("dispatch_loading_manifest", {
        p_manifest_id: manifest.id,
        p_departure_at: null,
      });
      toast.success(r.queued ? "Queued (offline)" : "Dispatched");
      invalidate();
      if (!r.queued) nav("/wm");
    } catch (e) {
      reportFailure(e, "dispatch");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading)
    return <MobileWarehouseLayout title="Dispatch" back="/wm">Loading…</MobileWarehouseLayout>;
  if (!manifest)
    return <MobileWarehouseLayout title="Dispatch" back="/wm">Manifest not found.</MobileWarehouseLayout>;

  const canLoad = manifest.state === "loading";
  const canClose = manifest.state === "loading";
  const canDispatch = manifest.state === "loading" || manifest.state === "closed";

  return (
    <MobileWarehouseLayout
      title="Dispatch"
      back="/wm"
      scanLabel="Scan carton or pallet label"
      scanContinuous

      bottomBar={
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-12"
            disabled={!canClose || busy}
            onClick={close}
          >
            <PackageCheck className="h-4 w-4 mr-1" /> Close
          </Button>
          <Button
            className="h-12"
            disabled={!canDispatch || busy}
            onClick={dispatch}
          >
            <Truck className="h-4 w-4 mr-1" /> Dispatch
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded border p-3">
          <div className="text-xs text-muted-foreground">Manifest</div>
          <div className="font-mono">{manifest.code}</div>
          <div className="text-xs mt-1">State: {manifest.state}</div>
        </div>

        {manifest.state !== "dispatched" && (
          <section className="rounded border p-3">
            <h2 className="mb-2 text-sm font-semibold">
              Proof of dispatch{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {proofStatus?.satisfied ? "· captured" : "· outstanding"}
              </span>
            </h2>
            <DispatchProofForm compact status={proofStatus} submitting={busy} onSubmit={captureProof} />
          </section>
        )}

        {canLoad && (
          <EntityScanField
            label="Scan carton LPN"
            intent="load.lpn"
            entity="carton"
            disabled={busy}
            onResolve={loadCode}
          />
        )}

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            Loaded · {(loaded ?? []).length}
          </h2>
          {(loaded ?? []).length === 0 ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No cartons loaded yet.
            </div>
          ) : (
            <ul className="space-y-1">
              {(loaded ?? []).map((l) => (
                <li
                  key={l.id}
                  className="rounded border p-2 flex justify-between items-center text-sm"
                >
                  <span className="font-mono">
                    #{l.sequence} · {l.carton?.id.slice(0, 8) ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {l.carton?.weight_kg != null ? `${l.carton.weight_kg}kg` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canLoad && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
              Available · {(available ?? []).filter((c) => !loadedIds.has(c.id)).length}
            </h2>
            <ul className="space-y-1">
              {(available ?? [])
                .filter((c) => !loadedIds.has(c.id))
                .slice(0, 20)
                .map((c) => (
                  <li
                    key={c.id}
                    className="rounded border p-2 flex justify-between items-center text-sm"
                  >
                    <span className="font-mono">{c.shipment_lpn?.code ?? c.id.slice(0, 8)}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.weight_kg != null ? `${c.weight_kg}kg` : ""}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </MobileWarehouseLayout>
  );
}
