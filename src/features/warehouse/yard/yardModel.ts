/**
 * Yard Control Tower — shared vocabulary, types and presentation helpers
 * (ADR 0086).
 *
 * The yard is a *pre-inventory operational layer*: it owns where a trailer
 * physically is, who is responsible for it, and how long it has been on
 * site. It never owns quantity or cost — Inventory does (ADR 0079/0080).
 *
 * Every operator-facing string for a yard enum lives here so a new enum
 * value is named in exactly one place.
 */

import { toneBorder, toneText, type Tone } from "@/design-system";

/* ------------------------------------------------------------------ */
/* Domain types                                                        */
/* ------------------------------------------------------------------ */

export type VisitStatus = "arrived" | "in_yard" | "at_dock" | "departed" | "no_show";

export type YardZoneKind =
  | "approach_lane"
  | "waiting_lane"
  | "parking_bay"
  | "staging"
  | "overflow";

export type YardSlotType = "inbound" | "outbound" | "either" | "hazmat" | "reefer";
export type YardSlotStatus = "available" | "occupied" | "blocked";

export type YardMoveReason =
  | "park"
  | "relocate"
  | "queue"
  | "to_dock"
  | "release"
  | "depart"
  | "no_show";

export type TrailerType =
  | "dry_van"
  | "reefer"
  | "flatbed"
  | "tanker"
  | "container"
  | "curtain_side"
  | "other";

export type TrailerOwnership = "own" | "carrier" | "customer" | "vendor" | "unknown";

export interface TrailerRow {
  id: string;
  code: string;
  trailer_type: TrailerType;
  ownership: TrailerOwnership;
  carrier_id: string | null;
  length_ft: number | null;
  capacity_weight: number | null;
  capacity_volume: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  carrier?: { name: string } | null;
}

export interface YardSlotRow {
  id: string;
  warehouse_id: string;
  code: string;
  slot_type: YardSlotType;
  status: YardSlotStatus;
  zone_kind: YardZoneKind | null;
  sequence: number | null;
  capacity: number | null;
  notes: string | null;
}

export interface VisitRow {
  id: string;
  warehouse_id: string;
  carrier_id: string | null;
  trailer_id: string | null;
  trailer_ref: string;
  driver_name: string | null;
  driver_phone: string | null;
  seal_in: string | null;
  seal_out: string | null;
  yard_slot_id: string | null;
  dock_id: string | null;
  appointment_id: string | null;
  arrived_at: string;
  docked_at: string | null;
  departed_at: string | null;
  dwell_minutes: number | null;
  status: VisitStatus;
  departure_approved_at: string | null;
  departure_override_reason: string | null;
  notes: string | null;
  carrier?: { name: string } | null;
  slot?: { code: string; zone_kind: string | null } | null;
  dock?: { name: string | null; code: string } | null;
  appointment?: {
    id: string;
    appointment_no: string | null;
    appointment_type: string;
    window_start: string;
    window_end: string;
    state: string;
    reference: string | null;
  } | null;
}

export interface YardMoveRow {
  id: string;
  visit_id: string;
  reason: YardMoveReason;
  from_slot_id: string | null;
  to_slot_id: string | null;
  from_dock_id: string | null;
  to_dock_id: string | null;
  from_status: string | null;
  to_status: string | null;
  notes: string | null;
  occurred_at: string;
  from_slot?: { code: string } | null;
  to_slot?: { code: string } | null;
  from_dock?: { code: string } | null;
  to_dock?: { code: string } | null;
}

/**
 * A jockey work order (ADR 0086 Phase 5). Yard moves are dispatched onto
 * the shared `wms_tasks` fabric so the physical move is claimable and
 * measurable, rather than being applied silently by a supervisor's drag.
 */
export interface YardMoveTaskRow {
  id: string;
  warehouse_id: string;
  state: string;
  priority: number;
  notes: string | null;
  created_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  assignee_user_id: string | null;
  payload: {
    visit_id?: string;
    trailer_ref?: string;
    from_slot_id?: string | null;
    from_dock_id?: string | null;
    to_slot_id?: string | null;
    to_dock_id?: string | null;
  } | null;
}

/**
 * What is physically on a trailer, and whether the warehouse is done with
 * it (ADR 0086 Phase 7). Sourced from the read-only
 * `wms_trailer_visit_load_summary` view so the yard never has to guess a
 * readiness signal from dwell time alone.
 */
export interface TrailerLoadSummaryRow {
  trailer_visit_id: string;
  warehouse_id: string | null;
  manifest_count: number;
  open_manifest_count: number;
  carton_count: number;
  earliest_planned_departure_at: string | null;
  receiving_session_count: number;
  open_receiving_count: number;
  expected_qty: number;
  received_qty: number;
  damaged_qty: number;
  readiness: "receiving" | "loading" | "ready" | "empty";
}

export const LOAD_READINESS_LABEL: Record<TrailerLoadSummaryRow["readiness"], string> = {
  receiving: "Unloading in progress",
  loading: "Loading in progress",
  ready: "Work complete — clear to depart",
  empty: "No warehouse work linked",
};

export const LOAD_READINESS_TONE: Record<
  TrailerLoadSummaryRow["readiness"],
  "info" | "warning" | "success" | "neutral"
> = {
  receiving: "info",
  loading: "warning",
  ready: "success",
  empty: "neutral",
};

/** Receiving completion, 0–100, or null when nothing is expected. */
export function receivingProgressPct(row: TrailerLoadSummaryRow): number | null {
  if (!row.expected_qty || Number(row.expected_qty) <= 0) return null;
  return Math.min(100, Math.round((Number(row.received_qty) / Number(row.expected_qty)) * 100));
}

export interface GateEventRow {
  id: string;
  event_type: string;
  identity_kind: string | null;
  identity_ref: string | null;
  seal_ref: string | null;
  approved: boolean | null;
  notes: string | null;
  occurred_at: string;
}

export interface DepartureBlocker {
  kind: "loading_manifest" | "receiving_session";
  id: string;
  code: string | null;
  state: string;
}

/* ------------------------------------------------------------------ */
/* Presentation contract                                               */
/* ------------------------------------------------------------------ */

export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  arrived: "At gate",
  in_yard: "In yard",
  at_dock: "At dock",
  departed: "Departed",
  no_show: "No show",
};

export const VISIT_STATUS_TONE: Record<VisitStatus, "info" | "warning" | "success" | "neutral" | "danger"> = {
  arrived: "info",
  in_yard: "warning",
  at_dock: "success",
  departed: "neutral",
  no_show: "danger",
};

/** Zone vocabulary — matches the `wms_yard_slots.zone_kind` check constraint. */
export const YARD_ZONE_LABEL: Record<YardZoneKind, string> = {
  approach_lane: "Approach lanes",
  waiting_lane: "Waiting lanes",
  parking_bay: "Parking bays",
  staging: "Staging",
  overflow: "Overflow",
};

/** Display order in the yard map — gate-inward. */
export const YARD_ZONE_ORDER: YardZoneKind[] = [
  "approach_lane",
  "waiting_lane",
  "parking_bay",
  "staging",
  "overflow",
];

export function yardZoneLabel(z: string | null | undefined): string {
  if (!z) return "Unzoned";
  return YARD_ZONE_LABEL[z as YardZoneKind] ?? z.replace(/_/g, " ");
}

export const SLOT_TYPE_LABEL: Record<YardSlotType, string> = {
  inbound: "Inbound",
  outbound: "Outbound",
  either: "Either",
  hazmat: "Hazmat",
  reefer: "Reefer",
};

export const TRAILER_TYPE_LABEL: Record<TrailerType, string> = {
  dry_van: "Dry van",
  reefer: "Reefer",
  flatbed: "Flatbed",
  tanker: "Tanker",
  container: "Container",
  curtain_side: "Curtain side",
  other: "Other",
};

export const TRAILER_OWNERSHIP_LABEL: Record<TrailerOwnership, string> = {
  own: "Own fleet",
  carrier: "Carrier",
  customer: "Customer",
  vendor: "Vendor",
  unknown: "Unknown",
};

export const YARD_MOVE_LABEL: Record<YardMoveReason, string> = {
  park: "Parked",
  relocate: "Relocated",
  queue: "Queued at gate",
  to_dock: "Moved to dock",
  release: "Released from dock",
  depart: "Departed site",
  no_show: "Marked no-show",
};

export const GATE_EVENT_LABEL: Record<string, string> = {
  checked_in: "Gate check-in",
  identity_verified: "Driver identity verified",
  seal_verified: "Seal verified",
  approved: "Security approved",
  rejected: "Rejected at gate",
  departure_approved: "Departure approved",
  exited: "Gate exit",
};

export function gateEventLabel(t: string): string {
  return GATE_EVENT_LABEL[t] ?? t.replace(/_/g, " ");
}

export function blockerLabel(b: DepartureBlocker): string {
  const kind = b.kind === "loading_manifest" ? "Loading manifest" : "Receiving session";
  return `${kind} ${b.code ?? b.id.slice(0, 8)} (${b.state.replace(/_/g, " ")})`;
}

/* ------------------------------------------------------------------ */
/* Dwell                                                               */
/* ------------------------------------------------------------------ */

/** Minutes on site for an open visit, or the recorded dwell once closed. */
export function dwellMinutes(v: Pick<VisitRow, "arrived_at" | "departed_at" | "dwell_minutes">): number {
  if (v.dwell_minutes != null) return Math.round(v.dwell_minutes);
  const end = v.departed_at ? new Date(v.departed_at).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(v.arrived_at).getTime()) / 60000));
}

export function formatDwell(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Ageing bands drive the colour language of the whole control tower. */
export type DwellBand = "fresh" | "watch" | "late" | "critical";

export function dwellBand(mins: number): DwellBand {
  if (mins < 60) return "fresh";
  if (mins < 120) return "watch";
  if (mins < 240) return "late";
  return "critical";
}

/** Dwell severity expressed in the ERP-wide tone vocabulary. */
export const DWELL_BAND_TONE: Record<DwellBand, Tone> = {
  fresh: "neutral",
  watch: "warning",
  late: "alert",
  critical: "danger",
};

export const DWELL_BAND_TEXT: Record<DwellBand, string> = {
  fresh: toneText(DWELL_BAND_TONE.fresh),
  watch: toneText(DWELL_BAND_TONE.watch),
  late: toneText(DWELL_BAND_TONE.late),
  critical: toneText(DWELL_BAND_TONE.critical),
};

export const DWELL_BAND_RING: Record<DwellBand, string> = {
  fresh: toneBorder(DWELL_BAND_TONE.fresh),
  watch: toneBorder(DWELL_BAND_TONE.watch),
  late: toneBorder(DWELL_BAND_TONE.late),
  critical: toneBorder(DWELL_BAND_TONE.critical),
};

/* ------------------------------------------------------------------ */
/* Derived operational signals                                         */
/* ------------------------------------------------------------------ */

export function isOnSite(v: VisitRow): boolean {
  return v.status === "arrived" || v.status === "in_yard" || v.status === "at_dock";
}

/** A visit whose appointment window has already closed while it waits. */
export function isOverdue(v: VisitRow): boolean {
  if (!v.appointment || v.status === "departed" || v.status === "no_show") return false;
  if (v.status === "at_dock") return false;
  return new Date(v.appointment.window_end).getTime() < Date.now();
}

export function isDepartureReady(v: VisitRow): boolean {
  return isOnSite(v) && v.departure_approved_at != null;
}

/* ------------------------------------------------------------------ */
/* Jockey work orders                                                  */
/* ------------------------------------------------------------------ */

export const YARD_TASK_STATE_LABEL: Record<string, string> = {
  pending: "Queued",
  ready: "Queued",
  claimed: "In progress",
  in_progress: "In progress",
  done: "Completed",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function yardTaskStateLabel(s: string): string {
  return YARD_TASK_STATE_LABEL[s] ?? s.replace(/_/g, " ");
}

export function isOpenYardMoveTask(t: YardMoveTaskRow): boolean {
  return t.state !== "completed" && t.state !== "cancelled";
}

/** Human destination for a work order, resolved against loaded master data. */
export function yardTaskDestination(
  t: YardMoveTaskRow,
  slots: YardSlotRow[],
  docks: { id: string; code: string; name: string | null }[],
): string {
  const slotId = t.payload?.to_slot_id;
  if (slotId) return slots.find((s) => s.id === slotId)?.code ?? "yard slot";
  const dockId = t.payload?.to_dock_id;
  if (dockId) {
    const d = docks.find((x) => x.id === dockId);
    return d ? `Dock ${d.name || d.code}` : "dock";
  }
  return "—";
}

/** The open work order for a visit, if the yard has already dispatched one. */
export function openTaskForVisit(
  visitId: string,
  tasks: YardMoveTaskRow[] | undefined,
): YardMoveTaskRow | null {
  return (tasks ?? []).find((t) => t.payload?.visit_id === visitId && isOpenYardMoveTask(t)) ?? null;
}
