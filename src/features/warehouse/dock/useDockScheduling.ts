/**
 * Dock scheduling data layer — every read is a scoped PostgREST query and
 * every write goes through a sanctioned RPC (never a direct table write).
 *
 * Consumers: DockSchedule (command centre), AppointmentPlanner,
 * RequestDockSlotDialog (cross-app origination), MobileGate.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  AppointmentDocumentRow,
  AppointmentRow,
  DockRow,
  DowntimeRow,
  TrailerVisitRow,
} from "./dockScheduling";

/* eslint-disable @typescript-eslint/no-explicit-any */

const APPT_COLUMNS =
  "id, appointment_no, dock_id, warehouse_id, appointment_type, priority, carrier_id, party_contact_id, reference, trailer_ref, tractor_ref, driver_name, driver_phone, window_start, window_end, scheduled_departure, arrived_at, completed_at, departed_at, state, cancelled_reason, qr_token";

export function useWarehouses() {
  return useQuery({
    queryKey: ["dock-warehouses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouses")
        .select("id, name, business_id")
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; business_id: string }[];
    },
  });
}

export function useDocks(warehouseId: string) {
  return useQuery({
    queryKey: ["dock-docks", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouse_docks")
        .select(
          "id, code, name, dock_type, warehouse_id, capabilities, operating_hours, default_turn_minutes",
        )
        .eq("warehouse_id", warehouseId)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as unknown as DockRow[];
    },
  });
}

export function useDayAppointments(warehouseId: string, day: string) {
  const dayStart = useMemo(() => new Date(`${day}T00:00:00`).toISOString(), [day]);
  const dayEnd = useMemo(() => new Date(`${day}T23:59:59.999`).toISOString(), [day]);

  return useQuery({
    queryKey: ["dock-appts", warehouseId, day],
    enabled: !!warehouseId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_dock_appointments")
        .select(APPT_COLUMNS)
        .eq("warehouse_id", warehouseId)
        .lte("window_start", dayEnd)
        .gte("window_end", dayStart)
        .order("window_start");
      if (error) throw error;
      return (data ?? []) as unknown as AppointmentRow[];
    },
  });
}

export function useDayDowntime(warehouseId: string, day: string) {
  const dayStart = useMemo(() => new Date(`${day}T00:00:00`).toISOString(), [day]);
  const dayEnd = useMemo(() => new Date(`${day}T23:59:59.999`).toISOString(), [day]);
  return useQuery({
    queryKey: ["dock-downtime", warehouseId, day],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_dock_downtime")
        .select("id, dock_id, reason, window_start, window_end, notes")
        .eq("warehouse_id", warehouseId)
        .lte("window_start", dayEnd)
        .gte("window_end", dayStart);
      if (error) throw error;
      return (data ?? []) as unknown as DowntimeRow[];
    },
  });
}

/** Trailers physically on site right now (yard + at dock). */
export function useLiveVisits(warehouseId: string) {
  return useQuery({
    queryKey: ["dock-live-visits", warehouseId],
    enabled: !!warehouseId,
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_trailer_visits")
        .select(
          "id, trailer_ref, carrier_id, driver_name, dock_id, yard_slot_id, appointment_id, status, arrived_at, docked_at, departed_at, dwell_minutes, seal_in, seal_out",
        )
        .eq("warehouse_id", warehouseId)
        .in("status", ["arrived", "in_yard", "at_dock"])
        .order("arrived_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as TrailerVisitRow[];
    },
  });
}

export function useAppointmentDocuments(appointmentId: string | null) {
  return useQuery({
    queryKey: ["dock-appt-docs", appointmentId],
    enabled: !!appointmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_appointment_documents")
        .select("id, appointment_id, doc_type, doc_id, doc_number, notes")
        .eq("appointment_id", appointmentId as string);
      if (error) throw error;
      return (data ?? []) as unknown as AppointmentDocumentRow[];
    },
  });
}

export function useGateEvents(appointmentId: string | null) {
  return useQuery({
    queryKey: ["dock-gate-events", appointmentId],
    enabled: !!appointmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_gate_events")
        .select("id, event_type, identity_kind, identity_ref, seal_ref, approved, notes, occurred_at")
        .eq("appointment_id", appointmentId as string)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        event_type: string;
        identity_kind: string | null;
        identity_ref: string | null;
        seal_ref: string | null;
        approved: boolean | null;
        notes: string | null;
        occurred_at: string;
      }[];
    },
  });
}

export function useCarriers() {
  return useQuery({
    queryKey: ["dock-carriers"],
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

/* ------------------------------------------------------------------ */
/* Writes — RPC only                                                   */
/* ------------------------------------------------------------------ */

export interface ScheduleAppointmentInput {
  dockId: string;
  type: "inbound" | "outbound";
  windowStart: string;
  windowEnd: string;
  carrierId?: string | null;
  reference?: string | null;
  priority?: string;
  partyContactId?: string | null;
  trailerRef?: string | null;
  tractorRef?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  scheduledDeparture?: string | null;
  requirements?: Record<string, unknown>;
  documents?: { doc_type: string; doc_id?: string | null; doc_number?: string | null }[];
}

export function useScheduleAppointment(onDone?: (id: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ScheduleAppointmentInput) => {
      const { data, error } = await supabase.rpc("schedule_dock_appointment" as any, {
        p_dock_id: input.dockId,
        p_type: input.type,
        p_window_start: input.windowStart,
        p_window_end: input.windowEnd,
        p_carrier_id: input.carrierId || null,
        p_reference: input.reference || null,
        p_priority: input.priority ?? "normal",
        p_party_contact_id: input.partyContactId || null,
        p_trailer_ref: input.trailerRef || null,
        p_tractor_ref: input.tractorRef || null,
        p_driver_name: input.driverName || null,
        p_driver_phone: input.driverPhone || null,
        p_scheduled_departure: input.scheduledDeparture || null,
        p_requirements: input.requirements ?? {},
        p_documents: input.documents ?? [],
      } as any);
      if (error) throw error;
      return data as string;
    },
    onSuccess: (id) => {
      toast.success("Appointment scheduled");
      qc.invalidateQueries({ queryKey: ["dock-appts"] });
      onDone?.(id);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to schedule"),
  });
}

export function useRescheduleAppointment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      appointmentId: string;
      dockId: string;
      windowStart: string;
      windowEnd: string;
    }) => {
      const { error } = await supabase.rpc("reschedule_dock_appointment" as any, {
        p_appointment_id: input.appointmentId,
        p_dock_id: input.dockId,
        p_window_start: input.windowStart,
        p_window_end: input.windowEnd,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Appointment moved");
      qc.invalidateQueries({ queryKey: ["dock-appts"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Move rejected"),
  });
}

export type AppointmentTransition =
  | "mark_appointment_arrived"
  | "start_appointment"
  | "complete_dock_appointment"
  | "cancel_dock_appointment";

export function useAppointmentTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; rpc: AppointmentTransition; reason?: string }) => {
      const args: Record<string, unknown> = { p_appointment_id: input.id };
      if (input.rpc === "cancel_dock_appointment") args.p_reason = input.reason ?? null;
      const { error } = await supabase.rpc(input.rpc as any, args as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Appointment updated");
      qc.invalidateQueries({ queryKey: ["dock-appts"] });
      qc.invalidateQueries({ queryKey: ["dock-live-visits"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Update rejected"),
  });
}

/** Server-side feasibility probe used before committing a slot. */
export async function checkDockFeasibility(input: {
  dockId: string;
  windowStart: string;
  windowEnd: string;
  requirements?: Record<string, unknown>;
  excludeAppointmentId?: string | null;
}): Promise<{ feasible: boolean; reasons: string[] }> {
  const { data, error } = await supabase.rpc("check_dock_feasibility" as any, {
    p_dock_id: input.dockId,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_requirements: input.requirements ?? {},
    p_exclude_appointment_id: input.excludeAppointmentId ?? null,
  } as any);
  if (error) throw error;
  const row = (data ?? {}) as { feasible?: boolean; reasons?: string[] };
  return { feasible: !!row.feasible, reasons: row.reasons ?? [] };
}

export function useFeasibility(input: {
  dockId: string;
  windowStart: string;
  windowEnd: string;
  requirements?: Record<string, unknown>;
  excludeAppointmentId?: string | null;
}) {
  const enabled = !!input.dockId && !!input.windowStart && !!input.windowEnd;
  return useQuery({
    queryKey: [
      "dock-feasibility",
      input.dockId,
      input.windowStart,
      input.windowEnd,
      JSON.stringify(input.requirements ?? {}),
      input.excludeAppointmentId ?? "",
    ],
    enabled,
    staleTime: 5_000,
    queryFn: () => checkDockFeasibility(input),
  });
}

/* ------------------------------------------------------------------ */
/* Gate operations                                                     */
/* ------------------------------------------------------------------ */

export function useGateCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
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
    }) => {
      const { data, error } = await supabase.rpc("gate_check_in" as any, {
        p_warehouse_id: input.warehouseId,
        p_trailer_ref: input.trailerRef,
        p_qr_token: input.qrToken || null,
        p_appointment_id: input.appointmentId || null,
        p_carrier_id: input.carrierId || null,
        p_driver_name: input.driverName || null,
        p_driver_phone: input.driverPhone || null,
        p_seal_in: input.sealIn || null,
        p_identity_kind: input.identityKind || null,
        p_identity_ref: input.identityRef || null,
      } as any);
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success("Checked in at gate");
      qc.invalidateQueries({ queryKey: ["dock-live-visits"] });
      qc.invalidateQueries({ queryKey: ["dock-appts"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Gate check-in failed"),
  });
}

export function useGateApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; approved: boolean; notes?: string }) => {
      const { error } = await supabase.rpc("gate_approve" as any, {
        p_visit_id: input.visitId,
        p_approved: input.approved,
        p_notes: input.notes ?? null,
      } as any);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success(v.approved ? "Trailer approved" : "Trailer rejected");
      qc.invalidateQueries({ queryKey: ["dock-live-visits"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
}

export function useGateExit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { visitId: string; sealOut?: string; notes?: string }) => {
      const { error } = await supabase.rpc("gate_exit" as any, {
        p_visit_id: input.visitId,
        p_seal_out: input.sealOut || null,
        p_notes: input.notes ?? null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trailer released");
      qc.invalidateQueries({ queryKey: ["dock-live-visits"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
}

/** Resolve an appointment from a scanned QR token (gate kiosk / handheld). */
export async function findAppointmentByToken(token: string): Promise<AppointmentRow | null> {
  const clean = token.trim().replace(/^APT:/i, "");
  const { data, error } = await supabase
    .from("wms_dock_appointments")
    .select(APPT_COLUMNS)
    .or(`qr_token.eq.${clean},appointment_no.eq.${clean.toUpperCase()}`)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as AppointmentRow) ?? null;
}
