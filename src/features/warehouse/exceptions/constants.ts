/**
 * Shared vocabulary for the Exceptions command centre.
 *
 * Every list here mirrors a Postgres enum. Keep them in sync with
 * `wms_exception_*` types — the RPCs reject anything outside the enum.
 */

export type ExceptionState =
  | "open" | "acknowledged" | "investigating" | "resolved" | "wont_fix" | "escalated";

export type ExceptionClass =
  | "informational" | "operational" | "quality" | "safety"
  | "compliance" | "financial" | "customer_impact";

export type OwnerRole =
  | "warehouse_supervisor" | "receiving_lead" | "inventory_controller"
  | "quality_inspector" | "pick_lead" | "pack_lead" | "shipping_lead"
  | "dock_coordinator" | "yard_marshal" | "maintenance" | "labour_planner"
  | "finance" | "procurement" | "it_support";

export type ResolutionKind =
  | "short_scan" | "damaged" | "wrong_bin" | "wrong_lp" | "legacy_short_dispatch"
  | "miscount" | "process_error" | "system_error" | "other" | "supplier_error"
  | "carrier_error" | "operator_error" | "equipment_failure" | "integration_error"
  | "data_entry_error" | "theft_or_loss" | "expiry" | "no_fault_found"
  | "duplicate_exception";

export type EvidenceType =
  | "barcode_scan" | "rfid_read" | "photo" | "signature" | "weight" | "dimension"
  | "temperature" | "humidity" | "sensor_reading" | "inspection_report"
  | "supplier_document" | "system_snapshot" | "external_reference" | "note";

export const EXCEPTION_CLASSES: ExceptionClass[] = [
  "operational", "quality", "safety", "compliance",
  "financial", "customer_impact", "informational",
];

export const OWNER_ROLES: OwnerRole[] = [
  "warehouse_supervisor", "receiving_lead", "inventory_controller",
  "quality_inspector", "pick_lead", "pack_lead", "shipping_lead",
  "dock_coordinator", "yard_marshal", "maintenance", "labour_planner",
  "finance", "procurement", "it_support",
];

export const RESOLUTION_KINDS: ResolutionKind[] = [
  "short_scan", "damaged", "wrong_bin", "wrong_lp", "miscount",
  "supplier_error", "carrier_error", "operator_error", "equipment_failure",
  "process_error", "system_error", "integration_error", "data_entry_error",
  "theft_or_loss", "expiry", "no_fault_found", "duplicate_exception",
  "legacy_short_dispatch", "other",
];

export const EVIDENCE_TYPES: EvidenceType[] = [
  "note", "photo", "barcode_scan", "rfid_read", "signature", "weight",
  "dimension", "temperature", "humidity", "sensor_reading",
  "inspection_report", "supplier_document", "system_snapshot",
  "external_reference",
];

export const OPEN_STATES: ExceptionState[] = [
  "open", "acknowledged", "investigating", "escalated",
];

export const TERMINAL_STATES: ExceptionState[] = ["resolved", "wont_fix"];

export const STATE_TONE: Record<ExceptionState, "info" | "warning" | "success" | "neutral" | "danger"> = {
  open: "warning",
  acknowledged: "info",
  investigating: "info",
  escalated: "danger",
  resolved: "success",
  wont_fix: "neutral",
};

export const CLASS_TONE: Record<ExceptionClass, "info" | "warning" | "success" | "neutral" | "danger"> = {
  informational: "neutral",
  operational: "info",
  quality: "warning",
  safety: "danger",
  compliance: "danger",
  financial: "warning",
  customer_impact: "danger",
};

export const severityTone = (n: number) =>
  n >= 4 ? "danger" : n === 3 ? "warning" : n === 2 ? "info" : "neutral";

export const severityLabel = (n: number) =>
  ({ 1: "low", 2: "medium", 3: "high", 4: "critical", 5: "critical" } as Record<number, string>)[n] ?? "medium";

/** `some_enum_value` → `Some enum value`. */
export const humanise = (v: string | null | undefined) =>
  !v ? "—" : v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Compact duration such as `45m`, `6h`, `3d`. */
export const shortDuration = (ms: number) => {
  const mins = Math.abs(Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
};

export interface ExceptionRow {
  id: string;
  organization_id: string;
  business_id: string | null;
  warehouse_id: string;
  kind: string;
  class: ExceptionClass | null;
  state: ExceptionState;
  severity: number;
  owner_role: OwnerRole | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  task_id: string | null;
  lpn_id: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  resolution: string | null;
  resolution_kind: ResolutionKind | null;
  due_by: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  acknowledged_at: string | null;
  escalated_at: string | null;
  escalation_level: number | null;
  sla_breached_at: string | null;
  financial_impact: number | null;
  impact_currency: string | null;
  source_system: string | null;
  created_at: string;
  resolved_at: string | null;
  row_version: number;
}
