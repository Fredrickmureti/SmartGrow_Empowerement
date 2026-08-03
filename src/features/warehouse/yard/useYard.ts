/**
 * Yard Control Tower data layer (ADR 0086).
 *
 * Reads are scoped PostgREST queries. Writes NEVER touch
 * `wms_trailer_visits` or `wms_yard_moves` directly — every transition
 * goes through the gate-aware RPC layer so each visit carries a complete
 * chain of custody:
 *
 *   gate_check_in → relocate_trailer → assign_trailer_to_dock →
 *   release_trailer_from_dock → approve_trailer_departure → gate_exit
 *
 * `check_in_trailer` / `depart_trailer` are internal building blocks of
 * the gate wrappers and must not be called from the UI.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useBusinesses } from "@/hooks/useBusinesses";
import type {
  DepartureBlocker,
  GateEventRow,
  TrailerRow,
  VisitRow,
  YardMoveRow,
  YardSlotRow,
} from "./yardModel";

/* eslint-disable @typescript-eslint/no-explicit-any */

const VISIT_COLUMNS =
  "id, warehouse_id, carrier_id, trailer_id, trailer_ref, driver_name, driver_phone, " +
  "seal_in, seal_out, yard_slot_id, dock_id, appointment_id, arrived_at, docked_at, " +
  "departed_at, dwell_minutes, status, departure_approved_at, departure_override_reason, notes, " +
  "carrier:carriers(name), slot:wms_yard_slots(code, zone_kind), dock:warehouse_docks(name, code), " +
  "appointment:wms_dock_appointments(id, appointment_no, appointment_type, window_start, window_end, state, reference)";

function invalidateYard(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    ["wms-trailer-visits"],
    ["wms-yard-slots"],
    ["wms-yard-moves"],
    ["wms-trailers"],
    ["wms-gate-events"],
    ["wms-departure-blockers"],
    ["dock-live-visits"],
  ]) {
    qc.invalidateQueries({ queryKey: key });
  }
}

function rpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Postgres prefixes RAISE EXCEPTION text; keep it readable for operators.
  return msg.replace(/^.*?:\s*/, "").trim() || "The yard action could not be completed.";
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function useYardVisits(warehouseId: string | null, opts?: { includeClosed?: boolean }) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    // Realtime (`useWmsRealtimeSync`) invalidates this prefix — no poll.
    queryKey: ["wms-trailer-visits", currentBusiness?.id, warehouseId, opts?.includeClosed ?? true],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_trailer_visits")
        .select(VISIT_COLUMNS)
        .eq("business_id", currentBusiness!.id)
        .order("arrived_at", { ascending: false })
        .limit(300);
      if (warehouseId) q = q.eq("warehouse_id", warehouseId);
      if (!opts?.includeClosed) q = q.in("status", ["arrived", "in_yard", "at_dock"]);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as VisitRow[];
    },
  });
}

export function useYardSlots(warehouseId: string | null) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["wms-yard-slots", currentBusiness?.id, warehouseId],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_yard_slots")
        .select("id, warehouse_id, code, slot_type, status, zone_kind, sequence, capacity, notes")
        .eq("business_id", currentBusiness!.id)
        .order("sequence", { ascending: true })
        .order("code", { ascending: true });
      if (warehouseId) q = q.eq("warehouse_id", warehouseId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as YardSlotRow[];
    },
  });
}

export function useYardDocks(warehouseId: string | null) {
  return useQuery({
    queryKey: ["wms-yard-docks", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouse_docks")
        .select("id, code, name, dock_type")
        .eq("warehouse_id", warehouseId as string)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as { id: string; code: string; name: string | null; dock_type: string }[];
    },
  });
}

export function useYardMoves(visitId: string | null) {
  return useQuery({
    queryKey: ["wms-yard-moves", visitId],
    enabled: !!visitId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("wms_yard_moves")
        .select(
          "id, visit_id, reason, from_slot_id, to_slot_id, from_dock_id, to_dock_id, from_status, to_status, notes, occurred_at, " +
            "from_slot:wms_yard_slots!wms_yard_moves_from_slot_id_fkey(code), " +
            "to_slot:wms_yard_slots!wms_yard_moves_to_slot_id_fkey(code), " +
            "from_dock:warehouse_docks!wms_yard_moves_from_dock_id_fkey(code), " +
            "to_dock:warehouse_docks!wms_yard_moves_to_dock_id_fkey(code)",
        )
        .eq("visit_id", visitId as string)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as YardMoveRow[];
    },
  });
}

export function useVisitGateEvents(visitId: string | null) {
  return useQuery({
    queryKey: ["wms-gate-events", visitId],
    enabled: !!visitId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_gate_events")
        .select("id, event_type, identity_kind, identity_ref, seal_ref, approved, notes, occurred_at")
        .eq("visit_id", visitId as string)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as GateEventRow[];
    },
  });
}

export function useDepartureBlockers(visitId: string | null) {
  return useQuery({
    queryKey: ["wms-departure-blockers", visitId],
    enabled: !!visitId,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)("trailer_departure_blockers", {
        p_visit_id: visitId,
      });
      if (error) throw error;
      return (data ?? []) as DepartureBlocker[];
    },
  });
}

export function useTrailers(search?: string) {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["wms-trailers", currentBusiness?.id, search ?? ""],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = (supabase as any)
        .from("wms_trailers")
        .select(
          "id, code, trailer_type, ownership, carrier_id, length_ft, capacity_weight, capacity_volume, is_active, notes, created_at, carrier:carriers(name)",
        )
        .eq("business_id", currentBusiness!.id)
        .order("code")
        .limit(500);
      if (search && search.trim()) q = q.ilike("code", `%${search.trim()}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as TrailerRow[];
    },
  });
}

export function useTrailerVisitHistory(trailerId: string | null) {
  return useQuery({
    queryKey: ["wms-trailer-visits", "history", trailerId],
    enabled: !!trailerId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("wms_trailer_visits")
        .select(VISIT_COLUMNS)
        .eq("trailer_id", trailerId as string)
        .order("arrived_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as VisitRow[];
    },
  });
}

export function useYardCarriers() {
  return useQuery({
    queryKey: ["wms-yard-carriers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carriers")
        .select("id, name")
        .eq("is_active", true)
        .order("name");
      if (error) return [] as { id: string; name: string }[];
      return (data ?? []) as { id: string; name: string }[];
    },
  });
}

/** Appointments still expecting a truck today — the gate's worklist. */
export function useExpectedAppointments(warehouseId: string | null) {
  const dayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const dayEnd = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }, []);

  return useQuery({
    queryKey: ["wms-dock-appointments", "expected", warehouseId, dayStart],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_dock_appointments")
        .select(
          "id, appointment_no, appointment_type, carrier_id, reference, trailer_ref, driver_name, driver_phone, window_start, window_end, state",
        )
        .eq("warehouse_id", warehouseId as string)
        .in("state", ["scheduled", "arrived"])
        .lte("window_start", dayEnd)
        .gte("window_end", dayStart)
        .order("window_start");
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        appointment_no: string | null;
        appointment_type: string;
        carrier_id: string | null;
        reference: string | null;
        trailer_ref: string | null;
        driver_name: string | null;
        driver_phone: string | null;
        window_start: string;
        window_end: string;
        state: string;
      }[];
    },
  });
}

/* ------------------------------------------------------------------ */
/* Writes — gate-aware RPCs only                                       */
/* ------------------------------------------------------------------ */

export interface GateCheckInInput {
  warehouseId: string;
  trailerRef: string;
  qrToken?: string | null;
  appointmentId?: string | null;
  carrierId?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  sealIn?: string | null;
  identityKind?: string | null;
  identityRef?: string | null;
}

export function useGateCheckIn(onDone?: (visit: VisitRow) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: GateCheckInInput) => {
      const { data, error } = await (supabase.rpc as any)("gate_check_in", {
        p_warehouse_id: input.warehouseId,
        p_trailer_ref: input.trailerRef,
        p_qr_token: input.qrToken ?? null,
        p_appointment_id: input.appointmentId ?? null,
        p_carrier_id: input.carrierId ?? null,
        p_driver_name: input.driverName ?? null,
        p_driver_phone: input.driverPhone ?? null,
        p_seal_in: input.sealIn ?? null,
        p_identity_kind: input.identityKind ?? null,
        p_identity_ref: input.identityRef ?? null,
      });
      if (error) throw error;
      return data as VisitRow;
    },
    onSuccess: (visit) => {
      invalidateYard(qc);
      toast.success(`${visit.trailer_ref} checked in`);
      onDone?.(visit);
    },
    onError: (e) => toast.error("Check-in failed", { description: rpcError(e) }),
  });
}

export function useGateApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; approved: boolean; notes?: string | null }) => {
      const { error } = await (supabase.rpc as any)("gate_approve", {
        p_visit_id: input.visitId,
        p_approved: input.approved,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      invalidateYard(qc);
      toast.success(v.approved ? "Security clearance recorded" : "Trailer rejected at gate");
    },
    onError: (e) => toast.error("Gate decision failed", { description: rpcError(e) }),
  });
}

export function useRelocateTrailer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; slotId: string; notes?: string | null }) => {
      const { error } = await (supabase.rpc as any)("relocate_trailer", {
        p_visit_id: input.visitId,
        p_slot_id: input.slotId,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateYard(qc);
      toast.success("Trailer moved");
    },
    onError: (e) => toast.error("Move failed", { description: rpcError(e) }),
  });
}

export function useAssignTrailerToDock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; dockId: string }) => {
      const { error } = await (supabase.rpc as any)("assign_trailer_to_dock", {
        p_visit_id: input.visitId,
        p_dock_id: input.dockId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateYard(qc);
      toast.success("Trailer assigned to dock");
    },
    onError: (e) => toast.error("Dock assignment failed", { description: rpcError(e) }),
  });
}

export function useReleaseFromDock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; slotId?: string | null; notes?: string | null }) => {
      const { error } = await (supabase.rpc as any)("release_trailer_from_dock", {
        p_visit_id: input.visitId,
        p_slot_id: input.slotId ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateYard(qc);
      toast.success("Trailer released from dock");
    },
    onError: (e) => toast.error("Release failed", { description: rpcError(e) }),
  });
}

export function useApproveDeparture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; overrideReason?: string | null }) => {
      const { error } = await (supabase.rpc as any)("approve_trailer_departure", {
        p_visit_id: input.visitId,
        p_override_reason: input.overrideReason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateYard(qc);
      toast.success("Cleared for departure");
    },
    onError: (e) => toast.error("Departure approval failed", { description: rpcError(e) }),
  });
}

export function useGateExit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; sealOut?: string | null; notes?: string | null }) => {
      const { error } = await (supabase.rpc as any)("gate_exit", {
        p_visit_id: input.visitId,
        p_seal_out: input.sealOut ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateYard(qc);
      toast.success("Trailer departed");
    },
    onError: (e) => toast.error("Gate exit failed", { description: rpcError(e) }),
  });
}

export function useMarkNoShow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; reason?: string | null }) => {
      const { error } = await (supabase.rpc as any)("mark_trailer_no_show", {
        p_visit_id: input.visitId,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateYard(qc);
      toast.success("Marked as no-show");
    },
    onError: (e) => toast.error("Could not mark no-show", { description: rpcError(e) }),
  });
}

/* ------------------------------------------------------------------ */
/* Master data (yard slots + trailer register are ordinary CRUD)       */
/* ------------------------------------------------------------------ */

export function useSaveYardSlot() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      warehouseId: string;
      code: string;
      slotType: string;
      zoneKind: string;
      sequence?: number | null;
      status?: string;
    }) => {
      if (input.id) {
        const { error } = await (supabase as any)
          .from("wms_yard_slots")
          .update({
            code: input.code,
            slot_type: input.slotType,
            zone_kind: input.zoneKind,
            sequence: input.sequence ?? null,
            ...(input.status ? { status: input.status } : {}),
          })
          .eq("id", input.id);
        if (error) throw error;
        return;
      }
      const { data: wh, error: whErr } = await supabase
        .from("warehouses")
        .select("organization_id, business_id")
        .eq("id", input.warehouseId)
        .single();
      if (whErr) throw whErr;
      const { error } = await (supabase as any).from("wms_yard_slots").insert({
        organization_id: (wh as any).organization_id,
        business_id: (wh as any).business_id ?? currentBusiness?.id,
        warehouse_id: input.warehouseId,
        code: input.code.trim(),
        slot_type: input.slotType,
        zone_kind: input.zoneKind,
        sequence: input.sequence ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-yard-slots"] });
      toast.success("Yard slot saved");
    },
    onError: (e) => toast.error("Could not save slot", { description: rpcError(e) }),
  });
}

export function useSetSlotBlocked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slotId: string; blocked: boolean }) => {
      const { error } = await (supabase as any)
        .from("wms_yard_slots")
        .update({ status: input.blocked ? "blocked" : "available" })
        .eq("id", input.slotId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-yard-slots"] }),
    onError: (e) => toast.error("Could not update slot", { description: rpcError(e) }),
  });
}

export function useSaveTrailer() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      code: string;
      trailerType: string;
      ownership: string;
      carrierId?: string | null;
      lengthFt?: number | null;
      capacityWeight?: number | null;
      isActive?: boolean;
      notes?: string | null;
    }) => {
      const payload = {
        code: input.code.trim().toUpperCase(),
        trailer_type: input.trailerType,
        ownership: input.ownership,
        carrier_id: input.carrierId || null,
        length_ft: input.lengthFt ?? null,
        capacity_weight: input.capacityWeight ?? null,
        is_active: input.isActive ?? true,
        notes: input.notes ?? null,
      };
      if (input.id) {
        const { error } = await (supabase as any).from("wms_trailers").update(payload).eq("id", input.id);
        if (error) throw error;
        return;
      }
      const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("organization_id")
        .eq("id", currentBusiness!.id)
        .single();
      if (bizErr) throw bizErr;
      const { error } = await (supabase as any).from("wms_trailers").insert({
        ...payload,
        organization_id: (biz as any).organization_id,
        business_id: currentBusiness!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-trailers"] });
      toast.success("Trailer saved");
    },
    onError: (e) => toast.error("Could not save trailer", { description: rpcError(e) }),
  });
}
