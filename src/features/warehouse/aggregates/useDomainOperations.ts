/**
 * Typed WMS domain-operation wrappers (ADR 0101 — Phase 2.4 §3).
 *
 * These hooks wrap the sanctioned domain RPCs that perform lifecycle
 * transitions *plus* side effects (task fan-out, stock reservation,
 * LPN status flips, adjustment posting, outbox emits). Pages must
 * consume these hooks — direct `supabase.rpc("release_pick_wave", …)`
 * calls from `src/pages/**` are forbidden and enforced by the
 * `wms-no-direct-domain-rpc.test.ts` architecture guard.
 *
 * The pure state transitions (draft→released without side effects, cancel,
 * etc.) live in `useAggregateTransitions.ts` and go through
 * `wms_transition_<aggregate>` RPCs directly.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

function normalizeError(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (msg.includes("Row version mismatch") || msg.includes("row_version")) {
    return "Someone else just updated this record. Refresh and try again.";
  }
  return msg || fallback;
}

// -------------------------------------------------------------------
// Wave — create + release
// -------------------------------------------------------------------
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
      const { data, error } = await supabase.rpc("create_pick_wave", {
        p_warehouse_id: input.warehouseId,
        p_sales_order_ids: input.salesOrderIds,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      const waveId = (data as { wave_id: string } | null)?.wave_id;
      if (!waveId) throw new Error("Wave not created");
      const { error: e2 } = await supabase.rpc("release_pick_wave", { p_wave_id: waveId });
      if (e2) throw e2;
      return waveId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
    },
    onError: (e) => toast.error(normalizeError(e, "Release failed")),
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
      const { error } = await supabase.rpc("complete_pick_task", {
        p_task_id: input.taskId,
        p_picked_qty: input.pickedQty,
        p_lpn_id: input.lpnId ?? null,
      });
      if (error) throw error;
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
      const { error } = await supabase.rpc("seal_pack_carton", {
        p_carton_id: input.cartonId,
        p_weight_kg: input.weightKg ?? null,
        p_dims: input.dims ?? null,
      });
      if (error) throw error;
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
      const { error } = await supabase.rpc("load_carton_onto_manifest", {
        p_manifest_id: manifestId!,
        p_carton_id: cartonId,
      });
      if (error) throw error;
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
      const { error } = await supabase.rpc("dispatch_loading_manifest", {
        p_manifest_id: manifestId!,
        p_departure_at: departureAt ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-manifest", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-manifest-cartons", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms-manifest-shortage", manifestId] });
      qc.invalidateQueries({ queryKey: ["wms_loading_manifests"] });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("WMS_SCAN_SHORTAGE")) {
        // Phase 3.7 §4 — scan-out enforcement. Force the operator back
        // to the loading floor rather than accepting a short shipment.
        toast.error("Cannot dispatch: sealed cartons are missing from this manifest.", {
          description: "Load every sealed carton for the wave/SO before dispatch.",
        });
        qc.invalidateQueries({ queryKey: ["wms-manifest-shortage", manifestId] });
        return;
      }
      toast.error(normalizeError(e, "Dispatch failed"));
    },
  });
}


// -------------------------------------------------------------------
// QC — accept / reject / cancel
// -------------------------------------------------------------------
export function useAcceptQcInspection(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { acceptedQty: number; notes?: string | null }) => {
      const { error } = await supabase.rpc("accept_qc_inspection", {
        p_inspection_id: id!,
        p_accepted_qty: input.acceptedQty,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
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
      const { error } = await supabase.rpc("reject_qc_inspection", {
        p_inspection_id: id!,
        p_rejected_qty: input.rejectedQty,
        p_disposition: input.disposition,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
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
      const { error } = await supabase.rpc("cancel_qc_inspection", {
        p_inspection_id: id!,
        p_reason: reason,
      });
      if (error) throw error;
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
      const { data, error } = await supabase.rpc("post_count_session", {
        p_session_id: sessionId!,
      });
      if (error) throw error;
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
