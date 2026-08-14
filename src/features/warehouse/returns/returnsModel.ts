/**
 * Returns domain types shared by the returns hooks and surfaces.
 *
 * The return *order* is the unit of authorization; the return *line* is the
 * unit of record. Every quantity, condition, inspection outcome and
 * disposition lands on `wms_return_lines` through an RPC — never as a
 * header-state flip and never only in an outbox payload.
 */

export type ReturnState =
  | "draft"
  | "authorized"
  | "in_transit"
  | "received"
  | "inspecting"
  | "disposed"
  | "closed"
  | "cancelled";

export type ReturnKind = "customer" | "vendor" | "internal" | "transfer";

export type ReturnCondition =
  | "unopened"
  | "opened"
  | "damaged"
  | "defective"
  | "expired"
  | "missing_accessories"
  | "incorrect_item";

export type ReturnInspectionState =
  | "pending"
  | "inspecting"
  | "passed"
  | "failed"
  | "conditional"
  | "waived";

export type ReturnDisposition =
  | "restock"
  | "scrap"
  | "repair"
  | "return_to_vendor"
  | "hold"
  | "quarantine"
  | "refurbish"
  | "quality_hold";

export interface ReturnOrder {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  warehouse_id: string;
  code: string;
  rma_reference: string | null;
  return_kind: ReturnKind;
  state: ReturnState;
  source_doc_type: string | null;
  source_doc_id: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  appointment_id: string | null;
  dock_id: string | null;
  trailer_visit_id: string | null;
  carrier_id: string | null;
  tracking_reference: string | null;
  finance_doc_type: string | null;
  finance_doc_id: string | null;
  credit_note_id: string | null;
  disposition_summary: Record<string, unknown> | null;
  expected_at: string | null;
  received_at: string | null;
  posted_at: string | null;
  closed_at: string | null;
  notes: string | null;
  row_version: number;
  created_at: string;
}

export interface ReturnLine {
  id: string;
  return_order_id: string;
  product_id: string | null;
  lpn_id: string | null;
  lpn_out_id: string | null;
  lot_number: string | null;
  serial_number: string | null;
  uom: string | null;
  expected_qty: number | null;
  received_qty: number | null;
  /** What the clerk typed, in `packaging_id`'s level (audit truth). */
  entered_qty: number | null;
  packaging_id: string | null;
  packaging?: { name: string | null } | null;
  condition_code: ReturnCondition | null;
  inspection_state: ReturnInspectionState;
  qc_inspection_id: string | null;
  disposition: ReturnDisposition | null;
  destination_location_id: string | null;
  restock_qty: number | null;
  quarantine_qty: number | null;
  scrap_qty: number | null;
  photo_count: number | null;
  blocked_reason: string | null;
  captured_at: string | null;
  inspected_at: string | null;
  dispositioned_at: string | null;
  posted_at: string | null;
  notes: string | null;
  row_version: number;
  created_at: string;
  products?: { name: string | null; sku: string | null } | null;
}

export interface ReturnPhoto {
  id: string;
  return_line_id: string;
  return_order_id: string;
  storage_bucket: string;
  storage_path: string;
  kind: string;
  caption: string | null;
  captured_at: string;
}

export interface ReturnDispositionRule {
  id: string;
  business_id: string;
  warehouse_id: string | null;
  name: string;
  return_kind: ReturnKind | null;
  condition_code: ReturnCondition | null;
  product_id: string | null;
  category_id: string | null;
  customer_id: string | null;
  disposition: ReturnDisposition;
  destination_location_id: string | null;
  requires_inspection: boolean;
  priority: number;
  is_active: boolean;
}

export const RETURN_OPEN_STATES: ReturnState[] = [
  "draft",
  "authorized",
  "in_transit",
  "received",
  "inspecting",
  "disposed",
];

export const RETURN_CONDITIONS: ReturnCondition[] = [
  "unopened",
  "opened",
  "damaged",
  "defective",
  "expired",
  "missing_accessories",
  "incorrect_item",
];

export const RETURN_DISPOSITIONS: ReturnDisposition[] = [
  "restock",
  "quarantine",
  "quality_hold",
  "repair",
  "refurbish",
  "return_to_vendor",
  "scrap",
  "hold",
];

export const RETURN_STATE_TONE: Record<
  ReturnState,
  "info" | "warning" | "success" | "neutral" | "danger"
> = {
  draft: "neutral",
  authorized: "info",
  in_transit: "info",
  received: "warning",
  inspecting: "warning",
  disposed: "success",
  closed: "success",
  cancelled: "neutral",
};

/** Operational lane a return sits in, derived from header + line state. */
export type ReturnLane =
  | "expected"
  | "at_dock"
  | "unloading"
  | "awaiting_inspection"
  | "blocked"
  | "awaiting_disposition"
  | "awaiting_posting"
  | "awaiting_finance"
  | "closed";

export function returnLane(order: ReturnOrder, lines: ReturnLine[]): ReturnLane {
  if (order.state === "closed" || order.state === "cancelled") return "closed";
  if (lines.some((l) => l.blocked_reason)) return "blocked";
  if (order.state === "draft" || order.state === "authorized") return "expected";
  if (order.state === "in_transit") return "at_dock";
  if (order.state === "received" && lines.every((l) => !l.captured_at)) return "unloading";
  if (lines.some((l) => l.captured_at && l.inspection_state === "pending"))
    return "awaiting_inspection";
  if (lines.some((l) => l.captured_at && !l.disposition)) return "awaiting_disposition";
  if (lines.some((l) => l.disposition && !l.posted_at)) return "awaiting_posting";
  if (!order.finance_doc_id) return "awaiting_finance";
  return "closed";
}

export const RETURN_LANE_LABEL: Record<ReturnLane, string> = {
  expected: "Expected",
  at_dock: "At dock",
  unloading: "Unloading",
  awaiting_inspection: "Awaiting inspection",
  blocked: "Blocked",
  awaiting_disposition: "Awaiting disposition",
  awaiting_posting: "Awaiting posting",
  awaiting_finance: "Awaiting finance",
  closed: "Closed",
};

/** Hours since a timestamp, for aging badges. */
export function ageHours(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 3_600_000);
}

/**
 * Lane SLA in hours — how long a return may sit in a lane before the lane
 * board calls it late. Physical lanes are tight (a parcel on the dock is
 * blocking a door); paperwork lanes get a working day.
 */
export const RETURN_LANE_SLA_HOURS: Record<ReturnLane, number> = {
  expected: 72,
  at_dock: 4,
  unloading: 4,
  awaiting_inspection: 8,
  awaiting_disposition: 12,
  awaiting_posting: 4,
  awaiting_finance: 24,
  blocked: 2,
  closed: Number.POSITIVE_INFINITY,
};

/** The clock a lane is measured against. */
export function returnLaneClock(order: ReturnOrder): string | null {
  return order.received_at ?? order.expected_at ?? order.created_at;
}

export interface LaneStat {
  count: number;
  /** Returns in this lane past their lane SLA. */
  breached: number;
  /** Age in hours of the oldest return in the lane. */
  oldestHours: number | null;
}

export function laneStats(
  orders: ReturnOrder[],
  linesByOrder: Map<string, ReturnLine[]>,
): Map<ReturnLane, LaneStat> {
  const stats = new Map<ReturnLane, LaneStat>();
  for (const order of orders) {
    const lane = returnLane(order, linesByOrder.get(order.id) ?? []);
    const age = ageHours(returnLaneClock(order));
    const prev = stats.get(lane) ?? { count: 0, breached: 0, oldestHours: null };
    stats.set(lane, {
      count: prev.count + 1,
      breached: prev.breached + (age != null && age > RETURN_LANE_SLA_HOURS[lane] ? 1 : 0),
      oldestHours:
        age == null ? prev.oldestHours : Math.max(prev.oldestHours ?? 0, age),
    });
  }
  return stats;
}

/** True when a single return has outstayed its lane SLA. */
export function isLaneBreached(order: ReturnOrder, lines: ReturnLine[]): boolean {
  const lane = returnLane(order, lines);
  const age = ageHours(returnLaneClock(order));
  return age != null && age > RETURN_LANE_SLA_HOURS[lane];
}

