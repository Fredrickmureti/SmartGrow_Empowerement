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
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import { toWmsFailure } from "@/features/warehouse/errors/wmsRpcError";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntityScanField } from "@/features/warehouse/scanning/EntityScanField";
import { entityCodeEquals } from "@/features/warehouse/scanning/wmsEntityScan";
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
      const failure = toWmsFailure(e, "Close failed");
      if (failure.code === "WMS_SCAN_SHORTAGE") {
        qc.invalidateQueries({ queryKey: ["wms-manifest-shortage", manifestId] });
      }
      toast.error(
        failure.code === "WMS_SCAN_SHORTAGE" ? `Cannot close: ${failure.message.toLowerCase()}` : failure.message,
        failure.description ? { description: failure.description } : {},
      );
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

  // Phase D — carrier abstraction. Tracking identity is allocated by an RPC,
  // never typed into the manifest by the client.
  const services = useCarrierServices(manifest?.carrier_id);
  const allocate = useAllocateTrackingNumber(manifestId);
  const [serviceId, setServiceId] = useState<string>("");
  const isOwnFleet = (manifest?.carrier?.carrier_kind ?? "own_fleet") === "own_fleet";

  // ADR 0109 — the manifest is the outbound spine; show the sales-side
  // deliveries this load actually carries.
  const { data: linkedNotes } = useQuery({
    queryKey: ["wms-manifest-delivery-notes", manifestId],
    enabled: !!manifestId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delivery_notes")
        .select("id, delivery_number, status")
        .eq("manifest_id", manifestId!)
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; delivery_number: string; status: string }>;
    },
  });

  /**
   * Phase 3 — the loading bay is a scan surface, not a text box. Admission
   * is gated by `gateEntityToken` (a product barcode is refused before any
   * lookup runs); resolution stays here because only this screen knows
   * which sealed cartons belong to this manifest's waves.
   */
  const resolveCartonScan = useCallback(
    async (code: string) => {
      const pool = available ?? [];
      const match = pool.find((c) => entityCodeEquals(c.shipment_lpn?.code, code));
      if (!match) {
        return { ok: false, message: "No sealed carton awaiting this manifest carries that LPN." };
      }
      if (loadedIds.has(match.id)) {
        return { ok: false, message: `${match.shipment_lpn?.code ?? code} is already loaded.` };
      }
      await load.mutateAsync(match.id);
      return { ok: true, message: `Loaded ${match.shipment_lpn?.code ?? code}.` };
    },
    [available, loadedIds, load],
  );

  if (isLoading) return <LoadingState />;
  if (!manifest) return <EmptyState icon={Truck} title="Manifest not found" action={<Button asChild><Link to="/warehouse-app/dispatch">Back</Link></Button>} />;

  const isComplete = shortCount === 0;
  const canLoad = manifest.state === "loading";

  /**
   * Close and Dispatch mirror the server, and say why when they refuse.
   *
   * The FSM only permits `loading → closed → dispatched`; the Dispatch
   * delegate closes an open load first, which is why Dispatch is offered
   * from `loading` too. Every other precondition here — full scan-out, at
   * least one carton, proof of dispatch — is re-enforced by
   * `wms_transition_manifest`, so a disabled button is never the security
   * boundary: it just spares the operator a rejected round-trip and names
   * the blocker instead of greying out silently.
   */
  const closeBlockedReason =
    manifest.state !== "loading"
      ? `This load is already ${manifest.state}.`
      : loadedCount === 0
        ? "Load at least one sealed carton before closing."
        : !isComplete
          ? `${shortCount} sealed carton${shortCount === 1 ? "" : "s"} for this load ${shortCount === 1 ? "is" : "are"} still on the floor.`
          : null;

  const dispatchBlockedReason =
    manifest.state === "dispatched"
      ? "This load has already departed."
      : manifest.state !== "loading" && manifest.state !== "closed"
        ? `A ${manifest.state} load cannot depart.`
        : loadedCount === 0
          ? "Load at least one sealed carton before dispatching."
          : !isComplete
            ? `${shortCount} sealed carton${shortCount === 1 ? "" : "s"} for this load ${shortCount === 1 ? "is" : "are"} still on the floor.`
            : !proofSatisfied
              ? "This warehouse requires proof of dispatch — capture the seal, driver and signature first."
              : null;

  const canClose = closeBlockedReason === null;
  const canDispatch = dispatchBlockedReason === null;




  return (
    <>
      <PageHeader
        title={<span className="font-mono">{manifest.code}</span>}
        description={
          <>
            State: <StatusBadge tone={manifest.state === "dispatched" ? "success" : "info"}>{manifest.state}</StatusBadge>
            {dispatchBlockedReason && manifest.state !== "dispatched" && (
              <span className="ml-2 text-muted-foreground">· {dispatchBlockedReason}</span>
            )}
          </>
        }
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild><Link to="/warehouse-app/dispatch"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link></Button>
            <DispatchDocumentsMenu manifestId={manifest.id} hideLabel={isOwnFleet} />
            <span title={closeBlockedReason ?? "Close this load to loading-complete."}>
              <Button variant="outline" disabled={!canClose || close.isPending} onClick={() => close.mutate()}>
                <PackageCheck className="h-4 w-4 mr-2" /> Close
              </Button>
            </span>
            <span title={dispatchBlockedReason ?? "Release this load — stock leaves the books on departure."}>
              <Button disabled={!canDispatch || dispatch.isPending} onClick={handleDispatch}>
                <Truck className="h-4 w-4 mr-2" /> Dispatch
              </Button>
            </span>
          </div>
        }
      />
      <PageBody>
        <Section
          title="Carrier & tracking"
          description="Who is carrying this load, under which service, and the tracking identity the customer will quote."
        >
          <div className="space-y-3">
            <div className="min-w-0 grid gap-3 @xl/page:grid-cols-3 text-sm">
              <div>
                <div className="text-muted-foreground">Carrier</div>
                <div className="font-medium">{manifest.carrier?.name ?? "Unassigned"}</div>
                <div className="text-xs text-muted-foreground">
                  {(manifest.carrier?.carrier_kind ?? "own_fleet").replace("_", " ")}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Tracking number</div>
                <div className="font-mono">{manifest.tracking_number ?? "—"}</div>
                {manifest.tracking_url && (
                  <a
                    className="text-xs underline text-primary"
                    href={manifest.tracking_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Track shipment
                  </a>
                )}
              </div>
              <div>
                <div className="text-muted-foreground">Delivery notes</div>
                {(linkedNotes ?? []).length === 0 ? (
                  <div className="text-muted-foreground">
                    {manifest.delivery_note_id ? "Linked" : "Consolidated / none linked"}
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {(linkedNotes ?? []).map((n) => (
                      <li key={n.id} className="flex items-center gap-2">
                        <FileText className="h-3 w-3 text-muted-foreground" />
                        <Link className="underline font-mono" to={`/sales/delivery-notes/${n.id}`}>
                          {n.delivery_number}
                        </Link>
                        <span className="text-xs text-muted-foreground">{n.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {manifest.state !== "dispatched" && manifest.carrier_id && (
              <div className="flex flex-wrap items-end gap-2">
                {(services.data ?? []).length > 0 && (
                  <div>
                    <Label>Service</Label>
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={serviceId || manifest.carrier_service_id || ""}
                      onChange={(e) => setServiceId(e.target.value)}
                    >
                      <option value="">Default</option>
                      {(services.data ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.transit_days ? ` · ${s.transit_days}d` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <Button
                  variant="outline"
                  disabled={allocate.isPending}
                  onClick={() => allocate.mutate(serviceId || manifest.carrier_service_id || null)}
                >
                  <Tag className="h-4 w-4 mr-2" />
                  {manifest.tracking_number ? "Re-issue tracking" : "Allocate tracking"}
                </Button>
              </div>
            )}
          </div>
        </Section>

        {manifest.state !== "dispatched" && proofStatus?.required && (
          <Section
            title="Proof of dispatch"
            description={
              proofStatus.satisfied
                ? "Custody evidence is on file — this load may depart."
                : "This warehouse requires seal, driver and signature before the load can leave."
            }
          >
            <div className="space-y-4">
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
            </div>
          </Section>
        )}

        {manifest.state !== "dispatched" && (
          <Section title={`Scan-out progress · ${scannedPct}%`}
            description={isComplete
              ? "All sealed cartons for this manifest's waves are loaded."
              : `${shortCount} sealed carton(s) still missing — dispatch is blocked until every one is loaded.`}>
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div
              className={isComplete ? "h-full bg-emerald-500 transition-all" : "h-full bg-amber-500 transition-all"}
              style={{ width: `${scannedPct}%` }}
            />
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            Loaded {loadedCount} · Missing {shortCount}
          </div>
          </Section>
        )}

        {canLoad && (
          <Section title="Scan carton LPN">
          <EntityScanField
            label="Carton LPN"
            intent="load.lpn"
            entity="carton"
            disabled={load.isPending}
            onResolve={resolveCartonScan}
          />
          </Section>
        )}

        <Section title={`Loaded (${(loaded ?? []).length})`} contentClassName="px-0 pb-0">
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
        </Section>

        {canLoad && (
          <Section title={`Available (${(available ?? []).filter((c) => !loadedIds.has(c.id)).length})`}
            description="Sealed cartons not yet on any manifest." contentClassName="px-0 pb-0">
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
          </Section>
        )}
        <ActivitySection aggregateId={manifestId} title="Manifest activity" description="Lifecycle events emitted for this loading manifest." />
      </PageBody>
    </>
  );
}
