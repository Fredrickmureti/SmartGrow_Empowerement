/**
 * Dock scheduling & yard operations — shared types, vocabulary and
 * presentation helpers (ADR 0080, Phase A–G).
 *
 * All operator-facing text for appointment/gate/yard enums lives here so
 * new enum values are added in one place (mirrors ADR 0100's humanize
 * contract for hardware).
 */
import { toneBorder, toneSurface, toneText, type Tone } from "@/design-system";

export type AppointmentState =
  | "scheduled"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type AppointmentPriority = "low" | "normal" | "high" | "critical";
export type AppointmentType = "inbound" | "outbound";

export interface DockCapabilities {
  refrigerated?: boolean;
  hazmat?: boolean;
  tail_lift?: boolean;
  dock_leveller?: boolean;
  max_vehicle_length_m?: number | null;
  max_weight_kg?: number | null;
  [k: string]: unknown;
}

export interface DockRow {
  id: string;
  code: string;
  name: string | null;
  dock_type: string;
  warehouse_id: string;
  capabilities: DockCapabilities | null;
  operating_hours: Record<string, unknown> | null;
  default_turn_minutes: number | null;
}

export interface AppointmentRow {
  id: string;
  appointment_no: string | null;
  dock_id: string;
  warehouse_id: string;
  appointment_type: AppointmentType;
  priority: AppointmentPriority | null;
  carrier_id: string | null;
  party_contact_id: string | null;
  reference: string | null;
  trailer_ref: string | null;
  tractor_ref: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  window_start: string;
  window_end: string;
  scheduled_departure: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  departed_at: string | null;
  state: AppointmentState;
  cancelled_reason: string | null;
  qr_token: string | null;
}

export interface AppointmentDocumentRow {
  id: string;
  appointment_id: string;
  doc_type: string;
  doc_id: string | null;
  doc_number: string | null;
  notes: string | null;
}

export interface DowntimeRow {
  id: string;
  dock_id: string;
  reason: string;
  window_start: string;
  window_end: string;
  notes: string | null;
}

export interface TrailerVisitRow {
  id: string;
  trailer_ref: string;
  carrier_id: string | null;
  driver_name: string | null;
  dock_id: string | null;
  yard_slot_id: string | null;
  appointment_id: string | null;
  status: string;
  arrived_at: string | null;
  docked_at: string | null;
  departed_at: string | null;
  dwell_minutes: number | null;
  seal_in: string | null;
  seal_out: string | null;
}

/* ------------------------------------------------------------------ */
/* Presentation contract                                               */
/* ------------------------------------------------------------------ */

export const APPOINTMENT_STATE_LABEL: Record<AppointmentState, string> = {
  scheduled: "Scheduled",
  arrived: "Arrived",
  in_progress: "At dock",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

/** Appointment state expressed in the ERP-wide tone vocabulary. */
export const APPOINTMENT_STATE_INTENT: Record<AppointmentState, Tone> = {
  scheduled: "neutral",
  arrived: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "danger",
  no_show: "danger",
};

const chip = (tone: Tone) =>
  `${toneSurface(tone)} ${toneText(tone)} ${toneBorder(tone)}`;

export const APPOINTMENT_STATE_TONE: Record<AppointmentState, string> = {
  scheduled: chip("neutral"),
  arrived: chip("info"),
  in_progress: chip("warning"),
  completed: chip("success"),
  cancelled: chip("danger"),
  no_show: chip("danger"),
};

export const PRIORITY_LABEL: Record<AppointmentPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
};

export const PRIORITY_INTENT: Record<AppointmentPriority, Tone> = {
  low: "neutral",
  normal: "neutral",
  high: "warning",
  critical: "danger",
};

export const PRIORITY_TONE: Record<AppointmentPriority, string> = {
  low: "text-muted-foreground",
  normal: "text-foreground",
  high: toneText("warning"),
  critical: toneText("danger"),
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  purchase_order: "Purchase order",
  inbound_shipment: "Inbound shipment (ASN)",
  goods_receipt: "Goods receipt",
  sales_order: "Sales order",
  delivery_note: "Delivery note",
  loading_manifest: "Loading manifest",
  return_order: "Return order",
  transfer: "Stock transfer",
};

export function docTypeLabel(t: string): string {
  return DOC_TYPE_LABEL[t] ?? t.replace(/_/g, " ");
}

export const GATE_EVENT_LABEL: Record<string, string> = {
  checked_in: "Gate check-in",
  verified: "Verified",
  rejected: "Rejected at gate",
  exited: "Gate exit",
};

export function gateEventLabel(t: string): string {
  return GATE_EVENT_LABEL[t] ?? t.replace(/_/g, " ");
}

export const YARD_ZONE_LABEL: Record<string, string> = {
  parking: "Parking",
  waiting: "Waiting lane",
  staging: "Staging",
  quarantine: "Quarantine",
  maintenance: "Maintenance",
};

export function yardZoneLabel(t: string | null | undefined): string {
  if (!t) return "Parking";
  return YARD_ZONE_LABEL[t] ?? t.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */

export function hhmm(t: string | null | undefined): string {
  if (!t) return "—";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

/** Local `YYYY-MM-DD` for the given date (never UTC-shifted). */
export function localDay(d: Date = new Date()): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

/** `datetime-local` input value for a Date. */
export function toLocalInput(d: Date): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** Requirement flags an appointment can demand of a dock. */
export const REQUIREMENT_FLAGS = [
  { key: "refrigerated", label: "Refrigerated / reefer" },
  { key: "hazmat", label: "Hazmat certified" },
  { key: "tail_lift", label: "Tail lift" },
  { key: "dock_leveller", label: "Dock leveller" },
] as const;

export type RequirementKey = (typeof REQUIREMENT_FLAGS)[number]["key"];
