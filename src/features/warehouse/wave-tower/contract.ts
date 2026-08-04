/**
 * Wave Control Tower — the operational contract.
 *
 * Every number the tower renders comes from one of the server-side wave
 * RPCs (`wms_wave_health`, `wms_wave_board`, `wms_wave_demand`,
 * `wms_wave_readiness`). The rules that decide whether a wave is ready,
 * at risk or late — stock coverage, labour capacity, departure feasibility,
 * open exceptions — live in SQL so the desktop tower, the RF shell and any
 * alerting engine cannot drift apart.
 *
 * This module owns the TypeScript shape of that contract plus pure
 * presentation helpers. No fetching, no aggregation, no classification.
 */
import type { HealthState } from "@/features/warehouse/control-center/contract";

export type { HealthState } from "@/features/warehouse/control-center/contract";

/** The outbound wave spine: plan → ready → pick → pack → dispatch. */
export type WaveStage =
  | "planning" | "ready" | "picking" | "packing" | "dispatch" | "suspended" | "closed";

export const WAVE_STAGE_ORDER: WaveStage[] = [
  "planning", "ready", "picking", "packing", "dispatch",
];

export const WAVE_STAGE_LABEL: Record<WaveStage, string> = {
  planning: "Planning",
  ready: "Ready to release",
  picking: "Picking",
  packing: "Packing",
  dispatch: "Ready to dispatch",
  suspended: "Suspended",
  closed: "Closed",
};

/** Server-assigned stage health. `idle` means nothing is at this stage. */
export type WaveStageHealth = "ok" | "warning" | "critical" | "idle";

export interface WaveHealthStage {
  stage: WaveStage;
  label: string;
  count: number;
  health: WaveStageHealth;
}

export interface WaveHealthTotals {
  open_waves: number;
  suspended: number;
  blocked: number;
  at_risk: number;
  late: number;
  planned_units: number;
  planned_hours: number;
}

export interface WaveHealth {
  warehouse_id: string;
  generated_at: string;
  stages: WaveHealthStage[];
  totals: WaveHealthTotals;
  health: WaveStageHealth;
}

/** Readiness — the server's verdict on whether a wave can be committed. */
export type ReadinessState = "ready" | "at_risk" | "blocked" | "unknown";

export interface ReadinessCheck {
  check: "stock" | "labour" | "departure" | "exceptions";
  state: ReadinessState;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface WaveReadiness {
  wave_id: string;
  state: ReadinessState;
  checked_at: string;
  checks: ReadinessCheck[];
}

export type WaveRisk = "late" | "exception" | "blocked" | "at_risk" | "on_track";

export interface WaveBoardRow {
  wave_id: string;
  wave_number: string;
  state: string;
  lifecycle_stage: WaveStage;
  strategy: string | null;
  strategy_name: string | null;
  priority: number;
  carrier_id: string | null;
  carrier_name: string | null;
  dock_id: string | null;
  dock_code: string | null;
  appointment_id: string | null;
  cutoff_at: string | null;
  released_at: string | null;
  completed_at: string | null;
  order_count: number;
  line_count: number;
  ordered_units: number;
  picked_units: number;
  packed_units: number;
  pick_progress_pct: number;
  pack_progress_pct: number;
  tasks_total: number;
  tasks_open: number;
  tasks_in_progress: number;
  open_exceptions: number;
  estimated_pick_minutes: number | null;
  readiness_state: ReadinessState;
  readiness: WaveReadiness | null;
  risk: WaveRisk;
  drill_route: string;
  row_version: number;
}

/** One open sales order and whether it can be waved. */
export interface WaveDemandRow {
  sales_order_id: string;
  so_number: string;
  contact_id: string | null;
  customer_name: string | null;
  expected_date: string | null;
  order_status: string;
  carrier_id: string | null;
  open_lines: number;
  open_units: number;
  covered_units: number;
  eligible: boolean;
  block_reason: string | null;
}

export interface WaveStrategy {
  id: string;
  warehouse_id: string;
  name: string;
  kind: string;
  is_active: boolean;
  sequence: number;
  group_by: string[];
  criteria: Record<string, unknown>;
  max_orders_per_wave: number;
  max_lines_per_wave: number;
  cutoff_offset_minutes: number | null;
  auto_plan: boolean;
  auto_release: boolean;
  wave_priority: number;
}

// ---------------------------------------------------------------------
// Presentation helpers — pure, no data access.
// ---------------------------------------------------------------------

export const RISK_LABEL: Record<WaveRisk, string> = {
  late: "Past cut-off",
  exception: "Exception",
  blocked: "Blocked",
  at_risk: "At risk",
  on_track: "On track",
};

export const RISK_TONE: Record<WaveRisk, HealthState> = {
  late: "critical",
  exception: "critical",
  blocked: "blocked",
  at_risk: "degraded",
  on_track: "healthy",
};

export const READINESS_LABEL: Record<ReadinessState, string> = {
  ready: "Ready",
  at_risk: "At risk",
  blocked: "Blocked",
  unknown: "Not evaluated",
};

export const CHECK_LABEL: Record<ReadinessCheck["check"], string> = {
  stock: "Stock coverage",
  labour: "Labour capacity",
  departure: "Departure",
  exceptions: "Exceptions",
};

export const STAGE_HEALTH_SURFACE: Record<WaveStageHealth, string> = {
  ok: "border-border bg-card",
  warning: "border-amber-500/40 bg-amber-500/5",
  critical: "border-destructive/40 bg-destructive/5",
  idle: "border-dashed border-border bg-muted/30",
};

export const STAGE_HEALTH_TEXT: Record<WaveStageHealth, string> = {
  ok: "text-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-destructive",
  idle: "text-muted-foreground",
};

/** "in 2h 10m" / "42m late" for a cut-off, without pulling in a date lib. */
export function cutoffLabel(cutoffAt: string | null): string {
  if (!cutoffAt) return "No cut-off";
  const diffMs = new Date(cutoffAt).getTime() - Date.now();
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const text = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return diffMs >= 0 ? `in ${text}` : `${text} late`;
}
