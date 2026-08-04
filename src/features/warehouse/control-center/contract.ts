/**
 * Supervisor Control Center — the health contract.
 *
 * Every number rendered by the control center comes from one of three
 * server-side RPCs (`wms_flow_health`, `wms_flow_bottlenecks`,
 * `wms_zone_load`). The health *rules* live in SQL so the desktop board,
 * the mobile board and any future alerting engine cannot drift apart.
 *
 * This module owns the TypeScript shape of that contract plus the pure
 * presentation helpers (tone, labels, age formatting). It contains no
 * data fetching and no aggregation.
 */

export type FlowStage =
  | "receive" | "inspect" | "putaway" | "store"
  | "replenish" | "pick" | "pack" | "load" | "dispatch";

export type HealthState = "healthy" | "degraded" | "critical" | "blocked";

export interface FlowStageHealth {
  stage: FlowStage;
  stage_order: number;
  label: string;
  drill_route: string;
  backlog: number;
  in_progress: number;
  unassigned: number;
  blocked: number;
  oldest_age_seconds: number;
  sla_at_risk: number;
  sla_breached: number;
  health: HealthState;
}

export interface FlowHealth {
  business_id: string;
  warehouse_id: string | null;
  generated_at: string;
  overall: HealthState;
  reason: string;
  worst_stage: string | null;
  stages: FlowStageHealth[];
}

export type BottleneckReasonCode =
  | "sla_breached" | "blocked_work" | "no_operator" | "aging_backlog"
  | "exception" | "dock_dwell" | "replenishment_starvation";

export interface Bottleneck {
  reason_code: BottleneckReasonCode;
  scope: string;
  reason: string;
  severity: number;
  impact_count: number;
  route: string;
}

export interface ZoneLoad {
  location_id: string | null;
  label: string;
  code: string | null;
  structure_level: string | null;
  backlog: number;
  in_progress: number;
  blocked: number;
  sla_breached: number;
  oldest_age_seconds: number;
}

/* ------------------------------------------------------------------ */
/* Presentation helpers — pure, no data access                         */
/* ------------------------------------------------------------------ */

export const HEALTH_ORDER: Record<HealthState, number> = {
  healthy: 0,
  degraded: 1,
  critical: 2,
  blocked: 3,
};

export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  critical: "Critical",
  blocked: "Blocked",
};

/** Text colour token per health state. */
export const HEALTH_TEXT: Record<HealthState, string> = {
  healthy: "text-success",
  degraded: "text-warning",
  critical: "text-destructive",
  blocked: "text-destructive",
};

/** Surface + border tokens per health state, for stage cards and banners. */
export const HEALTH_SURFACE: Record<HealthState, string> = {
  healthy: "border-success/40 bg-success/5",
  degraded: "border-warning/50 bg-warning/10",
  critical: "border-destructive/50 bg-destructive/10",
  blocked: "border-destructive bg-destructive/15",
};

/** Solid fill token, for the flow connector and heat cells. */
export const HEALTH_FILL: Record<HealthState, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  critical: "bg-destructive",
  blocked: "bg-destructive",
};

export const REASON_LABEL: Record<BottleneckReasonCode, string> = {
  sla_breached: "Past deadline",
  blocked_work: "Blocked",
  no_operator: "No operator",
  aging_backlog: "Aging backlog",
  exception: "Exception",
  dock_dwell: "Dock dwell",
  replenishment_starvation: "Starvation",
};

/** The corrective action a supervisor takes for each bottleneck class. */
export const REASON_ACTION: Record<BottleneckReasonCode, string> = {
  sla_breached: "Re-prioritise or reassign",
  blocked_work: "Resolve the blocker",
  no_operator: "Assign labour",
  aging_backlog: "Release more labour",
  exception: "Triage exception",
  dock_dwell: "Start unloading",
  replenishment_starvation: "Dispatch replenishment",
};

export function severityTone(severity: number): HealthState {
  if (severity >= 3) return "critical";
  if (severity === 2) return "degraded";
  return "healthy";
}

/** Compact age, e.g. "12m", "3h 40m", "2d". */
export function shortAge(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Milliseconds until (positive) or since (negative) an SLA timestamp. */
export function slaDelta(sla: string | null | undefined): number | null {
  if (!sla) return null;
  return new Date(sla).getTime() - Date.now();
}

/** Risk bucket for a single work item, used to order the live work panel. */
export type RiskBucket = "breached" | "at_risk" | "blocked" | "unassigned" | "aging" | "normal";

export const RISK_ORDER: RiskBucket[] = [
  "breached", "blocked", "at_risk", "unassigned", "aging", "normal",
];

export const RISK_LABEL: Record<RiskBucket, string> = {
  breached: "Overdue",
  blocked: "Blocked",
  at_risk: "At risk",
  unassigned: "Unassigned",
  aging: "Aging",
  normal: "On track",
};

export const RISK_TONE: Record<RiskBucket, HealthState> = {
  breached: "critical",
  blocked: "blocked",
  at_risk: "degraded",
  unassigned: "degraded",
  aging: "degraded",
  normal: "healthy",
};

const AGING_SECONDS = 7200;
const AT_RISK_MS = 30 * 60_000;

/**
 * Classifies one queue row. This is a per-row label for display ordering,
 * not an aggregation — stage and warehouse rollups always come from the
 * server contract.
 */
export function riskBucket(row: {
  state: string;
  sla_at: string | null;
  sla_breached?: boolean | null;
  assignee_user_id: string | null;
  created_at: string | null;
}): RiskBucket {
  if (row.state === "exception" || row.state === "paused") return "blocked";
  const delta = slaDelta(row.sla_at);
  if (row.sla_breached || (delta !== null && delta < 0)) return "breached";
  if (delta !== null && delta < AT_RISK_MS) return "at_risk";
  if (!row.assignee_user_id) return "unassigned";
  if (row.created_at &&
      Date.now() - new Date(row.created_at).getTime() > AGING_SECONDS * 1000) {
    return "aging";
  }
  return "normal";
}

export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ");
}
