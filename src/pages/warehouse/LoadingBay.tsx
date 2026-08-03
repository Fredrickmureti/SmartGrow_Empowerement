/**
 * LoadingBay — the scan-first loading workstation for a single
 * `wms_loading_manifest`. Every action delegates to a sanctioned RPC:
 *
 * - `load_carton_onto_manifest` — scan carton code → attach.
 * - `close_loading_manifest` → transition `loading → closed`.
 * - `dispatch_loading_manifest` → transition to `dispatched`; flips
 *   shipment LPNs to `shipped` and emits per-carton events.
 *
 * The client never writes `wms_loading_manifests`, `wms_manifest_cartons`,
 * or `wms_pack_cartons.manifest_id` directly.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import {
  useCaptureDispatchProof,
  useDispatchManifest,
  useLoadCartonOntoManifest,
  useManifestProofStatus,
  useAllocateTrackingNumber,
  useCarrierServices,
} from "@/features/warehouse/aggregates/useDomainOperations";
import { DispatchProofForm } from "@/features/warehouse/dispatch/DispatchProofForm";
import { DispatchDocumentsMenu } from "@/features/warehouse/dispatch/DispatchDocumentsMenu";
import { PageHeader, PageBody, Section, LoadingState, StatusBadge, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CheckCircle2, FileText, PackageCheck, ShieldCheck, Tag, Truck } from "lucide-react";

interface Manifest {
  id: string; code: string; state: string; warehouse_id: string;
  planned_departure_at: string | null; dispatched_at: string | null; closed_at: string | null;
  carrier_id: string | null; carrier_service_id: string | null;
  tracking_number: string | null; tracking_url: string | null;
  delivery_note_id: string | null;
  carrier: { name: string | null; carrier_kind: string | null } | null;
}
interface Loaded {
  id: string; sequence: number; loaded_at: string;
  carton: { id: string; sealed_at: string | null; weight_kg: number | null; shipment_lpn_id: string | null } | null;
  lpn: { code: string | null } | null;
}
interface AvailableCarton {
  id: string; sealed_at: string | null; weight_kg: number | null;
  shipment_lpn: { code: string } | null;
}

export default function LoadingBay() {
  const { manifestId } = useParams<{ manifestId: string }>();
  const qc = useQueryClient();
  const [scanCode, setScanCode] = useState("");

  const { data: manifest, isLoading } = useQuery({
    queryKey: ["wms-manifest", manifestId],
    enabled: !!manifestId,
    queryFn: async () => {
      const { data, error } = await supabase.from("wms_loading_manifests")
        .select(
          "id, code, state, warehouse_id, planned_departure_at, dispatched_at, closed_at, " +
          "carrier_id, carrier_service_id, tracking_number, tracking_url, delivery_note_id, " +
          "carrier:carrier_id(name, carrier_kind)",
        )
        .eq("id", manifestId!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as Manifest | null;
    },
  });

  const { data: loaded } = useQuery({
    queryKey: ["wms-manifest-cartons", manifestId],
    enabled: !!manifestId,
    queryFn: async () => {
      const { data, error } = await supabase.from("wms_manifest_cartons")
        .select("id, sequence, loaded_at, carton:carton_id(id, sealed_at, weight_kg, shipment_lpn_id)")
        .eq("manifest_id", manifestId!).order("sequence");
      if (error) throw error;
      const rows = (data ?? []) as unknown as Loaded[];
      // Resolve LPN codes in one shot.
      const lpnIds = rows.map((r) => r.carton?.shipment_lpn_id).filter(Boolean) as string[];
      if (!lpnIds.length) return rows;
      const { data: lpns } = await supabase.from("wms_license_plates").select("id, code").in("id", lpnIds);
      const codeById = new Map((lpns ?? []).map((l) => [l.id as string, l.code as string]));
      return rows.map((r) => ({ ...r, lpn: { code: r.carton?.shipment_lpn_id ? codeById.get(r.carton.shipment_lpn_id) ?? null : null } }));
    },
  });

  // Available cartons: sealed, same warehouse, no manifest yet.
  const { data: available } = useQuery({
    queryKey: ["wms-cartons-available", manifest?.warehouse_id],
    enabled: !!manifest?.warehouse_id && manifest?.state === "loading",
    queryFn: async () => {
      const { data, error } = await supabase.from("wms_pack_cartons")
        .select("id, sealed_at, weight_kg, shipment_lpn:shipment_lpn_id(code)")
        .is("manifest_id", null).not("sealed_at", "is", null).limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as AvailableCarton[];
    },
  });

  // Phase 3.7 §4 — scan-out preview. If any sealed carton for the manifest's
  // (wave, SO) pairs is missing, `dispatch_loading_manifest` refuses; show
  // the gap to the operator so they can go finish loading before hitting the
  // dispatch button.
  const { data: shortCartonIds } = useQuery({
    queryKey: ["wms-manifest-shortage", manifestId],
    enabled: !!manifestId && manifest?.state !== "dispatched",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wms_manifest_short_cartons", { p_manifest_id: manifestId! });
      if (error) throw error;
      return (data ?? []) as string[];
    },
    // Phase F — no poll. `wms_manifest_cartons` / `wms_loading_manifests`
    // are on the realtime publication and `useWmsRealtimeSync` invalidates
    // the `wms-manifest-shortage` prefix on every change.
  });
  const shortCount = shortCartonIds?.length ?? 0;
  const loadedCount = (loaded ?? []).length;
  const scannedPct = loadedCount + shortCount === 0
    ? 100
    : Math.round((loadedCount / (loadedCount + shortCount)) * 100);

  const loadedIds = useMemo(() => new Set((loaded ?? []).map((l) => l.carton?.id).filter(Boolean) as string[]), [loaded]);

  const load = useLoadCartonOntoManifest(manifestId);

  const close = useMutation({
    mutationFn: async () => {
      await replayGuardedCall("close_loading_manifest", { p_manifest_id: manifestId! });
    },
    onSuccess: () => { toast.success("Manifest closed"); qc.invalidateQueries({ queryKey: ["wms-manifest", manifestId] }); },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("WMS_SCAN_SHORTAGE")) {
        toast.error("Cannot close: sealed cartons are missing from this manifest.");
        qc.invalidateQueries({ queryKey: ["wms-manifest-shortage", manifestId] });
        return;
      }
      toast.error(msg || "Close failed");
    },
  });

  const dispatch = useDispatchManifest(manifestId);
  const handleDispatch = () => dispatch.mutate(null, { onSuccess: () => toast.success("Manifest dispatched") });

  // Phase C — proof of dispatch. The FSM refuses the departure without it
  // when the warehouse requires proof; the button mirrors that server rule.
  const proof = useManifestProofStatus(manifestId);
  const captureProof = useCaptureDispatchProof(manifestId);
  const proofStatus = proof.data ?? null;
  const proofSatisfied = proofStatus ? proofStatus.satisfied : true;

  const submitScan = () => {
    if (!scanCode.trim()) return;
    const match = (available ?? []).find((c) => c.shipment_lpn?.code?.toLowerCase() === scanCode.trim().toLowerCase());
    if (!match) { toast.error("No available carton matches that code"); return; }
    load.mutate(match.id, { onSuccess: () => setScanCode("") });
  };

  if (isLoading) return <LoadingState />;
  if (!manifest) return <EmptyState icon={Truck} title="Manifest not found" action={<Button asChild><Link to="/warehouse-app/dispatch">Back</Link></Button>} />;

  const isComplete = shortCount === 0;
  const canLoad = manifest.state === "loading";
  const canClose = manifest.state === "loading" && isComplete;
  const canDispatch =
    (manifest.state === "loading" || manifest.state === "closed") && isComplete && proofSatisfied;


  return (
    <>
      <PageHeader
        title={<span className="font-mono">{manifest.code}</span>}
        description={<>State: <StatusBadge tone={manifest.state === "dispatched" ? "success" : "info"}>{manifest.state}</StatusBadge></>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild><Link to="/warehouse-app/dispatch"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link></Button>
            <Button variant="outline" disabled={!canClose || close.isPending} onClick={() => close.mutate()}>
              <PackageCheck className="h-4 w-4 mr-2" /> Close
            </Button>
            <Button disabled={!canDispatch || dispatch.isPending} onClick={handleDispatch}>
              <Truck className="h-4 w-4 mr-2" /> Dispatch
            </Button>
          </div>
        }
      />
      <PageBody>
        {manifest.state !== "dispatched" && proofStatus?.required && (
          <Section
            title="Proof of dispatch"
            description={
              proofStatus.satisfied
                ? "Custody evidence is on file — this load may depart."
                : "This warehouse requires seal, driver and signature before the load can leave."
            }
          >
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <ShieldCheck className={proofStatus.satisfied ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-amber-600"} />
                  <StatusBadge tone={proofStatus.satisfied ? "success" : "warning"}>
                    {proofStatus.satisfied ? "Captured" : "Outstanding"}
                  </StatusBadge>
                  {proofStatus.captured_at && (
                    <span className="text-muted-foreground">
                      {new Date(proofStatus.captured_at).toLocaleString()}
                    </span>
                  )}
                </div>
                <DispatchProofForm
                  status={proofStatus}
                  submitting={captureProof.isPending}
                  onSubmit={(v) => captureProof.mutate(v)}
                />
              </CardContent>
            </Card>
          </Section>
        )}

        {manifest.state !== "dispatched" && (
          <Section title={`Scan-out progress · ${scannedPct}%`}
            description={isComplete
              ? "All sealed cartons for this manifest's waves are loaded."
              : `${shortCount} sealed carton(s) still missing — dispatch is blocked until every one is loaded.`}>
            <Card><CardContent className="p-4">
              <div className="h-2 w-full rounded bg-muted overflow-hidden">
                <div
                  className={isComplete ? "h-full bg-emerald-500 transition-all" : "h-full bg-amber-500 transition-all"}
                  style={{ width: `${scannedPct}%` }}
                />
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                Loaded {loadedCount} · Missing {shortCount}
              </div>
            </CardContent></Card>
          </Section>
        )}

        {canLoad && (
          <Section title="Scan carton LPN">
            <Card><CardContent className="p-4 flex gap-2 items-end">
              <div className="flex-1">
                <Label>Carton LPN code</Label>
                <Input autoFocus value={scanCode} onChange={(e) => setScanCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitScan(); }} placeholder="Scan or type…" />
              </div>
              <Button onClick={submitScan} disabled={load.isPending}>Load</Button>
            </CardContent></Card>
          </Section>
        )}

        <Section title={`Loaded (${(loaded ?? []).length})`}>
          <Card><CardContent className="p-0">
            {(loaded ?? []).length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No cartons loaded yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr className="text-left">
                  <th className="p-2">#</th><th className="p-2">LPN</th><th className="p-2">Weight</th><th className="p-2">Loaded</th>
                </tr></thead>
                <tbody>
                  {(loaded ?? []).map((l) => (
                    <tr key={l.id} className="border-t">
                      <td className="p-2 font-mono">{l.sequence}</td>
                      <td className="p-2 font-mono">{l.lpn?.code ?? "—"}</td>
                      <td className="p-2">{l.carton?.weight_kg != null ? `${l.carton.weight_kg} kg` : "—"}</td>
                      <td className="p-2 text-muted-foreground">{new Date(l.loaded_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent></Card>
        </Section>

        {canLoad && (
          <Section title={`Available (${(available ?? []).filter((c) => !loadedIds.has(c.id)).length})`}
            description="Sealed cartons not yet on any manifest.">
            <Card><CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr className="text-left">
                  <th className="p-2">LPN</th><th className="p-2">Weight</th><th className="p-2">Sealed</th><th className="p-2"></th>
                </tr></thead>
                <tbody>
                  {(available ?? []).filter((c) => !loadedIds.has(c.id)).slice(0, 50).map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="p-2 font-mono">{c.shipment_lpn?.code ?? "—"}</td>
                      <td className="p-2">{c.weight_kg != null ? `${c.weight_kg} kg` : "—"}</td>
                      <td className="p-2 text-muted-foreground">{c.sealed_at ? new Date(c.sealed_at).toLocaleString() : "—"}</td>
                      <td className="p-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => load.mutate(c.id)} disabled={load.isPending}>
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Load
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(available ?? []).filter((c) => !loadedIds.has(c.id)).length === 0 && (
                    <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No available cartons.</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent></Card>
          </Section>
        )}
        <ActivitySection aggregateId={manifestId} title="Manifest activity" description="Lifecycle events emitted for this loading manifest." />
      </PageBody>
    </>
  );
}
