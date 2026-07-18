/**
 * Mobile dispatch — scan carton LPNs onto a loading manifest, then close /
 * dispatch. Counterpart to desktop `LoadingBay.tsx`. Every state transition
 * is RPC-only through `enqueue()`:
 *
 *   load_carton_onto_manifest
 *   close_loading_manifest
 *   dispatch_loading_manifest
 */
import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
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
  const [scan, setScan] = useState("");
  const [busy, setBusy] = useState(false);

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
  };

  const loadCode = async () => {
    const code = scan.trim();
    if (!code || busy || !manifest) return;
    const match = (available ?? []).find(
      (c) => (c.shipment_lpn?.code ?? "").toLowerCase() === code.toLowerCase(),
    );
    if (!match) {
      toast.error("No sealed carton with that LPN");
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue("load_carton_onto_manifest", {
        p_manifest_id: manifest.id,
        p_carton_id: match.id,
      });
      toast.success(r.queued ? "Queued (offline)" : "Carton loaded");
      setScan("");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Load failed");
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!manifest || busy) return;
    setBusy(true);
    try {
      const r = await enqueue("close_loading_manifest", { p_manifest_id: manifest.id });
      toast.success(r.queued ? "Queued (offline)" : "Manifest closed");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Close failed");
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
      toast.error(e instanceof Error ? e.message : "Dispatch failed");
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

        {canLoad && (
          <div>
            <Label>Scan carton LPN</Label>
            <div className="flex gap-2">
              <Input
                autoFocus
                inputMode="text"
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadCode();
                }}
                placeholder="Scan carton…"
                className="h-12 text-lg font-mono flex-1"
              />
              <Button className="h-12" disabled={busy || !scan.trim()} onClick={loadCode}>
                Load
              </Button>
            </div>
          </div>
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
