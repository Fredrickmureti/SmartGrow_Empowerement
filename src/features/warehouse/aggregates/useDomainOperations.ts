/**
 * Typed WMS domain-operation wrappers (ADR 0101 — Phase 2.4 §3).
 *
 * Phase 5.1: every mutating call here dispatches through
 * `replayGuardedCall()` so a double-click, a React-Query retry, or a
 * resubmitted form can never apply the same quantity movement twice.
 *
 * These hooks wrap the sanctioned domain RPCs that perform lifecycle
 * transitions *plus* side effects (task fan-out, stock reservation,
 * LPN status flips, adjustment posting, outbox emits). Pages must
 * consume these hooks — direct domain-RPC calls from pages
 * calls from `src/pages/**` are forbidden and enforced by the
 * `wms-no-direct-domain-rpc.test.ts` architecture guard.
 *
 * The pure state transitions (draft→released without side effects, cancel,
 * etc.) live in `useAggregateTransitions.ts` and go through
 * `wms_transition_<aggregate>` RPCs directly.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import { toWmsFailure } from "@/features/warehouse/errors/wmsRpcError";

/**
 * Every warehouse mutation funnels its rejection through the shared WMS
 * failure contract. PostgREST rejections are plain objects, so the old
 * `e instanceof Error ? e.message : String(e)` shape rendered
 * `[object Object]` and never matched a coded business rule.
 */
function normalizeError(e: unknown, fallback: string) {
  return toWmsFailure(e, fallback).message;
}

// -------------------------------------------------------------------
// Wave — create + release
// -------------------------------------------------------------------

/** Release result as returned by the guarded release routine. */
interface ReleaseWaveResult {
  tasks_created?: number;
  short_pick_tasks?: number;
  replenishment_tasks?: number;
  readiness?: string;
  noop?: boolean;
}

/**
 * The single call site of the release routine. Both the manual batching
 * path and the tower's release button funnel through here so release
 * semantics can never fork.
 */
async function callReleaseWave(waveId: string, force = false) {
  const { data } = await replayGuardedCall<ReleaseWaveResult | null>("release_pick_wave", {
    p_wave_id: waveId,
    p_force: force,
  });
  return data ?? null;
}


export interface CreateAndReleaseWaveInput {
  warehouseId: string;
  salesOrderIds: string[];
  notes?: string | null;
}

export function useCreateAndReleaseWave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAndReleaseWaveInput) => {
      if (!input.warehouseId) throw new Error("Pick a warehouse");
      if (input.salesOrderIds.length === 0) throw new Error("Select at least one sales order");
      const { data } = await replayGuardedCall<{ wave_id?: string } | null>("create_pick_wave", {
        p_warehouse_id: input.warehouseId,
        p_sales_order_ids: input.salesOrderIds,
        p_notes: input.notes ?? null,
      });
      const waveId = data?.wave_id;
      if (!waveId) throw new Error("Wave not created");
      await callReleaseWave(waveId);
      return waveId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Release failed")),
  });
}

/**
 * Release an existing draft wave (Phase 5 — supervisor release console).
 *
 * Auto-waving (`wms_enqueue_order_for_wave`) builds draft waves from
 * sales-order allocations; nothing becomes operator work until a
 * supervisor releases it here. Release is reservation-consistent and
 * idempotent server-side.
 */
export function useReleaseWave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | { waveId: string; force?: boolean }) => {
      const waveId = typeof input === "string" ? input : input.waveId;
      const force = typeof input === "string" ? false : !!input.force;
      return await callReleaseWave(waveId, force);

    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
      qc.invalidateQueries({ queryKey: ["wms-draft-waves"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-wave-board"] });
      qc.invalidateQueries({ queryKey: ["wms-wave-health"] });
      qc.invalidateQueries({ queryKey: ["wms-wave-demand"] });
      if (res?.noop) {
        toast.info("Wave was already released");
      } else {
        const short = res?.short_pick_tasks ?? 0;
        const replen = res?.replenishment_tasks ?? 0;
        toast.success(
          `Released — ${res?.tasks_created ?? 0} task(s) generated` +
            (short > 0 ? `, ${short} short-pick` : "") +
            (replen > 0 ? `, ${replen} replenishment` : ""),
        );
      }
    },
    onError: (e) => toast.error(normalizeError(e, "Release failed")),
  });
}

// -------------------------------------------------------------------
// Wave — plan from strategy, and evaluate readiness
// -------------------------------------------------------------------

/**
 * Build planned waves from the warehouse's active wave strategies.
 *
 * Planning is a proposal: it groups demand and estimates work, but it
 * touches neither stock nor tasks. Commitment happens at release.
 */
export function usePlanWaves() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { warehouseId: string; strategyId?: string | null }) => {
      if (!input.warehouseId) throw new Error("Pick a warehouse");
      const { data, error } = await supabase.rpc("wms_plan_waves" as never, {
        p_warehouse_id: input.warehouseId,
        p_strategy_id: input.strategyId ?? null,
      } as never);
      if (error) throw error;
      return data as unknown as { waves_created?: number } | null;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["wms-wave-board"] });
      qc.invalidateQueries({ queryKey: ["wms-wave-health"] });
      qc.invalidateQueries({ queryKey: ["wms-wave-demand"] });
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
      const n = res?.waves_created ?? 0;
      if (n === 0) toast.info("No new waves — nothing matched an active strategy");
      else toast.success(`${n} wave(s) planned`);
    },
    onError: (e) => toast.error(normalizeError(e, "Planning failed")),
  });
}

/**
 * Re-run the readiness engine for one wave and persist the verdict.
 *
 * The same rule gates release server-side, so what the supervisor sees here
 * is exactly what the release RPC will enforce.
 */
export function useEvaluateWave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (waveId: string) => {
      const { data, error } = await supabase.rpc("wms_evaluate_wave" as never, {
        p_wave_id: waveId,
      } as never);
      if (error) throw error;
      return data as unknown as { state?: string } | null;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["wms-wave-board"] });
      qc.invalidateQueries({ queryKey: ["wms-wave-health"] });
      const s = res?.state ?? "unknown";
      if (s === "ready") toast.success("Wave is ready to release");
      else if (s === "at_risk") toast.warning("Wave is at risk — see the readiness panel");
      else toast.error("Wave is blocked — see the readiness panel");
    },
    onError: (e) => toast.error(normalizeError(e, "Readiness check failed")),
  });
}


// -------------------------------------------------------------------
// Pick — complete task
// -------------------------------------------------------------------
export interface CompletePickTaskInput {
  taskId: string;
  pickedQty: number;
  lpnId?: string | null;
}

export function useCompletePickTask(waveId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CompletePickTaskInput) => {
      await replayGuardedCall("complete_pick_task", {
        p_task_id: input.taskId,
        p_picked_qty: input.pickedQty,
        p_lpn_id: input.lpnId ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-pick-tasks", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-wave", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Pick failed")),
  });
}

// -------------------------------------------------------------------
// Pack — seal carton
// -------------------------------------------------------------------
export interface SealCartonInput {
  cartonId: string;
  weightKg?: number | null;
  dims?: { length_cm: number | null; width_cm: number | null; height_cm: number | null } | null;
}

export function useSealCarton(waveId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SealCartonInput) => {
      await replayGuardedCall("seal_pack_carton", {
        p_carton_id: input.cartonId,
        p_weight_kg: input.weightKg ?? null,
        p_dims: input.dims ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-pack-cartons", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pack-wave", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Seal failed")),
  });
}

// -------------------------------------------------------------------
// Loading — load carton + dispatch
// -------------------------------------------------------------------
export function useLoadCartonOntoManifest(manifestId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cartonId: string) => {
      await replayGuardedCall("load_carton_onto_manifest", {
        p_manifest_id: manifestId!,
        p_carton_id: cartonId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-manifest-cartons", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-manifest", manifestId] });
    },
    onError: (e) => toast.error(normalizeError(e, "Load failed")),
  });
}

export function useDispatchManifest(manifestId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (departureAt?: string | null) => {
      await replayGuardedCall("dispatch_loading_manifest", {
        p_manifest_id: manifestId!,
        p_departure_at: departureAt ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-manifest", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-manifest-cartons", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-manifest-shortage", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms_loading_manifests"] });
    },
    onError: (e) => {
      const failure = toWmsFailure(e, "Dispatch failed");
      if (failure.code === "WMS_SCAN_SHORTAGE") {
        // Phase 3.7 §4 — scan-out enforcement. Force the operator back
        // to the loading floor rather than accepting a short shipment.
        toast.error("Cannot dispatch: sealed cartons are missing from this manifest.", {
          description: "Load every sealed carton for the wave/SO before dispatch.",
        });
        qc.invalidateQueries({ queryKey: ["wms-manifest-shortage", manifestId] });
        return;
      }
      toast.error(failure.message, failure.description ? { description: failure.description } : {});
    },
  });
}

// -------------------------------------------------------------------
// Proof of dispatch (Phase C)
// -------------------------------------------------------------------
export interface DispatchProofInput {
  sealNumber?: string | null;
  driverName?: string | null;
  driverIdRef?: string | null;
  signatureUrl?: string | null;
  photoUrls?: string[];
  gpsLat?: number | null;
  gpsLng?: number | null;
  notes?: string | null;
}

export interface ManifestProofStatus {
  required: boolean;
  captured: boolean;
  satisfied: boolean;
  seal_number: string | null;
  driver_name: string | null;
  signature_url: string | null;
  photo_urls: string[];
  captured_at: string | null;
}

/** Args for `wms_capture_dispatch_proof`, shared by desktop and RF shells. */
export function dispatchProofArgs(manifestId: string, v: DispatchProofInput) {
  return {
    p_manifest_id: manifestId,
    p_seal_number: v.sealNumber ?? null,
    p_driver_name: v.driverName ?? null,
    p_driver_id_ref: v.driverIdRef ?? null,
    p_signature_url: v.signatureUrl ?? null,
    p_photo_urls: v.photoUrls ?? [],
    p_gps_lat: v.gpsLat ?? null,
    p_gps_lng: v.gpsLng ?? null,
    p_notes: v.notes ?? null,
  };
}

export function useManifestProofStatus(manifestId: string | null | undefined) {
  return useQuery({
    queryKey: ["wms-manifest-proof", manifestId],
    enabled: !!manifestId,
    queryFn: async (): Promise<ManifestProofStatus | null> => {
      const { data, error } = await supabase.rpc("wms_manifest_proof_status", {
        p_manifest_id: manifestId!,
      });
      if (error) throw error;
      return (data ?? null) as unknown as ManifestProofStatus | null;
    },
  });
}

export function useCaptureDispatchProof(manifestId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: DispatchProofInput) => {
      await replayGuardedCall("wms_capture_dispatch_proof", dispatchProofArgs(manifestId!, values));
    },
    onSuccess: () => {
      toast.success("Proof of dispatch captured");
      qc.invalidateQueries({ queryKey: ["wms-manifest-proof", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-manifest", manifestId] });
    },
    onError: (e) => toast.error(normalizeError(e, "Could not capture proof")),
  });
}

// -------------------------------------------------------------------
// Carrier abstraction (Phase D, ADR-0110)
//
// `wms_allocate_tracking_number` is the ONLY write path for a manifest's
// tracking identity. It is adapter-shaped: today it mints an internal
// deterministic number, tomorrow a live carrier API can return one under
// the same contract, and no caller changes.
// -------------------------------------------------------------------
export interface ManifestTracking {
  manifest_id: string;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier_kind: string | null;
}

export function useCarrierServices(carrierId: string | null | undefined) {
  return useQuery({
    queryKey: ["wms-carrier-services", carrierId],
    enabled: !!carrierId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carrier_services")
        .select("id, code, name, transit_days")
        .eq("carrier_id", carrierId!)
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAllocateTrackingNumber(manifestId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (serviceId?: string | null) => {
      const { data } = await replayGuardedCall<ManifestTracking>(
        "wms_allocate_tracking_number",
        { p_manifest_id: manifestId!, p_service_id: serviceId ?? null },
      );
      return data ?? null;
    },
    onSuccess: (res) => {
      toast.success(res?.tracking_number ? `Tracking ${res.tracking_number}` : "Tracking allocated");
      qc.invalidateQueries({ queryKey: ["wms-manifest", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-loading-manifests"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Could not allocate tracking")),
  });
}


// -------------------------------------------------------------------
// QC — accept / reject / cancel
// -------------------------------------------------------------------
export function useAcceptQcInspection(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { acceptedQty: number; notes?: string | null }) => {
      await replayGuardedCall("accept_qc_inspection", {
        p_inspection_id: id!,
        p_accepted_qty: input.acceptedQty,
        p_notes: input.notes ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-qc-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wms-qc-inspections"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Accept failed")),
  });
}

export function useRejectQcInspection(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { rejectedQty: number; disposition: string; notes?: string | null }) => {
      await replayGuardedCall("reject_qc_inspection", {
        p_inspection_id: id!,
        p_rejected_qty: input.rejectedQty,
        p_disposition: input.disposition,
        p_notes: input.notes ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-qc-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wms-qc-inspections"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Reject failed")),
  });
}

export function useCancelQcInspection(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) => {
      await replayGuardedCall("cancel_qc_inspection", {
        p_inspection_id: id!,
        p_reason: reason,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-qc-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wms-qc-inspections"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Cancel failed")),
  });
}

// -------------------------------------------------------------------
// Cycle count — post
// -------------------------------------------------------------------
export function usePostCountSession(sessionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await replayGuardedCall("post_count_session", {
        p_session_id: sessionId!,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-count-session", sessionId] });
      qc.invalidateQueries({ queryKey: ["wms-count-lines-review", sessionId] });
      qc.invalidateQueries({ queryKey: ["wms-count-sessions"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Post failed")),
  });
}
