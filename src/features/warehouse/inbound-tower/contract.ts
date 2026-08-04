/**
 * Inbound Control Tower — the operational contract.
 *
 * Every number the tower renders comes from one of four server-side RPCs
 * (`wms_inbound_health`, `wms_inbound_arrivals`, `wms_inbound_bottlenecks`,
 * `wms_inbound_dock_board`). The rules that decide *healthy / degraded /
 * critical / blocked*, what counts as a blocker, what stage an arrival is
 * physically at and what counts as SLA risk live in SQL so the desktop
 * board, the mobile board and alerting cannot drift apart.
 *
 * This module owns the TypeScript shape of that contract plus pure
 * presentation helpers. It contains no data fetching, no aggregation and no
 * classification — in particular the exception taxonomy is server-side, and
 * nothing here inspects exception text.
 */
import type { HealthState } from "@/features/warehouse/control-center/contract";

export type {
  HealthState,
  FlowStageHealth,
} from "@/features/warehouse/control-center/contract";
export {
  HEALTH_FILL, HEALTH_LABEL, HEALTH_SURFACE, HEALTH_TEXT, HEALTH_ORDER,
  shortAge, humanise,
} from "@/features/warehouse/control-center/contract";

import type { FlowStageHealth } from "@/features/warehouse/control-center/contract";

/** The inbound spine — the chain a receipt walks from booking to stock. */
export type InboundStage =
  | "appointment" | "gate" | "yard" | "dock" | "unload"
  | "capture" | "inspect" | "crossdock" | "putaway";

export interface InboundHealth {
  business_id: string;
  warehouse_id: string | null;
  generated_at: string;
  overall: HealthState;
  reason: string;
  worst_stage: string | null;
  stages: FlowStageHealth[];
}

/** Where an arrival physically is, as decided by the server. */
export type ArrivalStage =
  | "appointment" | "gate" | "yard" | "dock" | "unload"
  | "capture" | "inspect" | "putaway" | "available";

export const ARRIVAL_ORDER: ArrivalStage[] = [
  "appointment", "gate", "yard", "dock", "unload",
  "capture", "inspect", "putaway", "available",
];

export const ARRIVAL_LABEL: Record<ArrivalStage, string> = {
  appointment: "Booked",
  gate: "At gate",
  yard: "In yard",
  dock: "At dock",
  unload: "Unloading",
  capture: "Capturing",
  inspect: "Inspection",
  putaway: "Put-away",
  available: "Available",
};

export type ArrivalRisk = "breached" | "blocked" | "at_risk" | "normal" | "done";

export const RISK_LABEL: Record<ArrivalRisk, string> = {
  breached: "Missed window",
  blocked: "Blocked",
  at_risk: "At risk",
  normal: "On track",
  done: "Received",
};

export const RISK_TONE: Record<ArrivalRisk, HealthState> = {
  breached: "critical",
  blocked: "blocked",
  at_risk: "degraded",
  normal: "healthy",
  done: "healthy",
};

export interface InboundArrival {
  appointment_id: string | null;
  session_id: string | null;
  appointment_no: string | null;
  reference: string | null;
  appointment_state: string | null;
  priority: string | number | null;
  window_start: string | null;
  window_end: string | null;
  appointment_arrived_at: string | null;
  trailer_ref: string | null;
  driver_name: string | null;
  carrier_name: string | null;
  visit_id: string | null;
  visit_status: string | null;
  visit_arrived_at: string | null;
  docked_at: string | null;
  dwell_minutes: number | null;
  yard_slot_code: string | null;
  dock_id: string | null;
  dock_code: string | null;
  session_code: string | null;
  session_state: string | null;
  session_started_at: string | null;
  line_count: number;
  captured_lines: number;
  expected_qty: number;
  received_qty: number;
  damaged_qty: number;
  short_lines: number;
  over_lines: number;
  hold_lines: number;
  unexpected_lines: number;
  damaged_lines: number;
  qc_pending: number;
  crossdock_pending: number;
  putaway_open: number;
  putaway_done: number;
  exception_count: number;
  exception_breached: number;
  lifecycle_stage: ArrivalStage;
  minutes_to_window: number | null;
  risk: ArrivalRisk;
  drill_route: string;
  receive_pct: number | null;
}

export type InboundReasonCode =
  | "late_arrival" | "no_dock" | "yard_dwell" | "unload_stalled"
  | "short_receipt" | "over_receipt" | "damaged" | "qc_hold"
  | "crossdock_expiring" | "putaway_backlog" | "no_operator"
  | "exception" | "sla_breached";

export interface InboundBottleneck {
  reason_code: InboundReasonCode;
  scope: string;
  reason: string;
  severity: number;
  impact_count: number;
  route: string;
}

export const INBOUND_REASON_LABEL: Record<InboundReasonCode, string> = {
  late_arrival: "Late arrival",
  no_dock: "No dock",
  yard_dwell: "Yard dwell",
  unload_stalled: "Unload stalled",
  short_receipt: "Short receipt",
  over_receipt: "Over receipt",
  damaged: "Damage",
  qc_hold: "QC hold",
  crossdock_expiring: "Cross-dock expiring",
  putaway_backlog: "Put-away backlog",
  no_operator: "No operator",
  exception: "Exception",
  sla_breached: "Past deadline",
};

export const INBOUND_REASON_ACTION: Record<InboundReasonCode, string> = {
  late_arrival: "Chase the carrier or re-book the slot",
  no_dock: "Assign a dock to the appointment",
  yard_dwell: "Call the trailer to a dock",
  unload_stalled: "Assign labour to the unload",
  short_receipt: "Confirm the shortage with the supplier",
  over_receipt: "Decide accept or reject on the overage",
  damaged: "Raise the damage claim and quarantine",
  qc_hold: "Make the inspection decision",
  crossdock_expiring: "Stage the cross-dock before it lapses",
  putaway_backlog: "Release labour to put-away",
  no_operator: "Assign labour",
  exception: "Triage the exception",
  sla_breached: "Escalate — the deadline has passed",
};

export interface InboundDockSlot {
  dock_id: string;
  code: string;
  name: string | null;
  dock_type: string | null;
  open_sessions: number;
  visit_id: string | null;
  trailer_ref: string | null;
  docked_at: string | null;
  next_window_at: string | null;
  occupied: boolean;
}

export interface WaitingTrailer {
  visit_id: string;
  trailer_ref: string | null;
  status: string | null;
  arrived_at: string | null;
  waiting_minutes: number | null;
  yard_slot_id: string | null;
}

export interface InboundDockBoard {
  generated_at: string;
  docks: InboundDockSlot[];
  waiting_trailers: WaitingTrailer[];
  yard_slots: { total: number; free: number };
}

/* ------------------------------------------------------------------ */
/* Pure presentation helpers                                           */
/* ------------------------------------------------------------------ */

/** "in 42m", "35m late", "—" — relative to the booked window. */
export function windowCountdown(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const abs = Math.abs(minutes);
  const text = abs < 60
    ? `${abs}m`
    : abs < 1440
      ? `${Math.floor(abs / 60)}h ${abs % 60}m`
      : `${Math.floor(abs / 1440)}d`;
  return minutes < 0 ? `${text} late` : `in ${text}`;
}

/** Label for an arrival, preferring what a receiving clerk recognises. */
export function arrivalLabel(a: InboundArrival): string {
  return a.session_code ?? a.appointment_no ?? a.reference
    ?? a.trailer_ref ?? "Unbooked arrival";
}

/** Stable React key — an arrival may be an appointment, a session, or both. */
export function arrivalKey(a: InboundArrival): string {
  return `${a.appointment_id ?? "na"}:${a.session_id ?? "ns"}`;
}
