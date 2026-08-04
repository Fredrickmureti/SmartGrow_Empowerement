/**
 * Outbound Control Tower — the operational contract.
 *
 * Every number the tower renders comes from one of four server-side RPCs
 * (`wms_outbound_health`, `wms_outbound_shipments`, `wms_outbound_bottlenecks`,
 * `wms_outbound_dock_board`). The rules that decide *healthy / degraded /
 * critical / blocked*, what counts as a blocker and what counts as SLA risk
 * live in SQL so the desktop board, mobile and alerting cannot drift apart.
 *
 * This module owns the TypeScript shape of that contract plus pure
 * presentation helpers. It contains no data fetching and no aggregation, and
 * it reuses the shared health vocabulary from the supervisor control centre
 * rather than forking it.
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

/** The outbound spine — the chain a load walks before it leaves the site. */
export type OutboundStage =
  | "release" | "pick" | "pack" | "stage" | "load" | "dispatch";

export interface OutboundHealth {
  business_id: string;
  warehouse_id: string | null;
  generated_at: string;
  overall: HealthState;
  reason: string;
  worst_stage: string | null;
  stages: FlowStageHealth[];
}

/** Where a load physically is in its lifecycle. */
export type LifecycleStage =
  | "planned" | "released" | "picking" | "packing" | "staged"
  | "manifested" | "loading" | "sealed" | "dispatched";

export const LIFECYCLE_ORDER: LifecycleStage[] = [
  "planned", "released", "picking", "packing", "staged",
  "manifested", "loading", "sealed", "dispatched",
];

export const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  planned: "Planned",
  released: "Released",
  picking: "Picking",
  packing: "Packing",
  staged: "Staged",
  manifested: "Manifested",
  loading: "Loading",
  sealed: "Sealed",
  dispatched: "Dispatched",
};

export type ShipmentRisk = "breached" | "blocked" | "at_risk" | "normal" | "done";

export const RISK_LABEL: Record<ShipmentRisk, string> = {
  breached: "Missed departure",
  blocked: "Blocked",
  at_risk: "At risk",
  normal: "On track",
  done: "Dispatched",
};

export const RISK_TONE: Record<ShipmentRisk, HealthState> = {
  breached: "critical",
  blocked: "blocked",
  at_risk: "degraded",
  normal: "healthy",
  done: "healthy",
};

export const RISK_RANK: ShipmentRisk[] = [
  "breached", "blocked", "at_risk", "normal", "done",
];

export interface OutboundShipment {
  wave_id: string | null;
  wave_number: string | null;
  wave_state: string | null;
  manifest_id: string | null;
  manifest_code: string | null;
  manifest_state: string | null;
  lifecycle_stage: LifecycleStage;
  created_at: string;
  released_at: string | null;
  line_count: number;
  qty_ordered: number;
  qty_picked: number;
  qty_packed: number;
  short_lines: number;
  carton_count: number;
  carton_sealed: number;
  carton_manifested: number;
  carton_loaded: number;
  pick_pct: number | null;
  pack_pct: number | null;
  load_pct: number | null;
  open_tasks: number;
  unassigned_tasks: number;
  blocked_tasks: number;
  exception_count: number;
  blocked_reason: string | null;
  dock_id: string | null;
  dock_code: string | null;
  trailer_visit_id: string | null;
  trailer_ref: string | null;
  trailer_status: string | null;
  has_proof: boolean;
  planned_departure_at: string | null;
  dispatched_at: string | null;
  sla_at: string | null;
  minutes_to_departure: number | null;
  risk: ShipmentRisk;
  drill_route: string;
}

export type OutboundReasonCode =
  | "sla_breached" | "missing_proof" | "no_dock" | "staging_backlog"
  | "short_pick" | "no_operator" | "blocked_work" | "exception" | "dock_dwell";

export interface OutboundBottleneck {
  reason_code: OutboundReasonCode;
  scope: string;
  reason: string;
  severity: number;
  impact_count: number;
  route: string;
}

export const OUTBOUND_REASON_LABEL: Record<OutboundReasonCode, string> = {
  sla_breached: "Past departure",
  missing_proof: "No proof",
  no_dock: "No dock",
  staging_backlog: "Staging backlog",
  short_pick: "Short pick",
  no_operator: "No operator",
  blocked_work: "Blocked",
  exception: "Exception",
  dock_dwell: "Dock dwell",
};

export const OUTBOUND_REASON_ACTION: Record<OutboundReasonCode, string> = {
  sla_breached: "Escalate or re-plan the departure",
  missing_proof: "Capture seal and signature",
  no_dock: "Assign a dock",
  staging_backlog: "Assign cartons to a manifest",
  short_pick: "Resolve the inventory shortage",
  no_operator: "Assign labour",
  blocked_work: "Clear the blocker",
  exception: "Triage the exception",
  dock_dwell: "Dock the trailer",
};

export interface DockSlot {
  dock_id: string;
  code: string;
  name: string | null;
  dock_type: string | null;
  open_manifests: number;
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

export interface DockBoard {
  generated_at: string;
  docks: DockSlot[];
  waiting_trailers: WaitingTrailer[];
  yard_slots: { total: number; free: number };
}

/* ------------------------------------------------------------------ */
/* Pure presentation helpers                                           */
/* ------------------------------------------------------------------ */

/** "in 42m", "35m late", "—". */
export function departureCountdown(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const abs = Math.abs(minutes);
  const text = abs < 60
    ? `${abs}m`
    : abs < 1440
      ? `${Math.floor(abs / 60)}h ${abs % 60}m`
      : `${Math.floor(abs / 1440)}d`;
  return minutes < 0 ? `${text} late` : `in ${text}`;
}

/** Progress of a load through the lifecycle, 0–100, for the rail fill. */
export function lifecycleProgress(stage: LifecycleStage): number {
  const i = LIFECYCLE_ORDER.indexOf(stage);
  if (i < 0) return 0;
  return Math.round((i / (LIFECYCLE_ORDER.length - 1)) * 100);
}

/** Label for a shipment, preferring the manifest a supervisor dispatches. */
export function shipmentLabel(s: OutboundShipment): string {
  return s.manifest_code ?? s.wave_number ?? "Unnamed load";
}

/** Stable React key — a load may exist as a wave, a manifest, or both. */
export function shipmentKey(s: OutboundShipment): string {
  return `${s.wave_id ?? "nw"}:${s.manifest_id ?? "nm"}`;
}
