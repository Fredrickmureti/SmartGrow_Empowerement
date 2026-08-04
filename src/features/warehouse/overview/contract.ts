/**
 * Warehouse Overview — the command-centre contract (ADR 0102).
 *
 * The Overview is an *aggregator*: it owns no warehouse logic. Health, flow,
 * bottlenecks, arrivals, shipments, labour and zone load are all read from
 * the modules that own them (control-center, inbound-tower, outbound-tower,
 * labour). This module adds only the three lenses no other surface owned —
 * capacity, equipment health and the live activity feed — plus the pure
 * ranking used to merge every bottleneck feed into one priority stack.
 *
 * No data fetching here. No classification of server-side taxonomies.
 */
import type { Bottleneck } from "@/features/warehouse/control-center/contract";
import type { InboundBottleneck } from "@/features/warehouse/inbound-tower/contract";
import type { OutboundBottleneck } from "@/features/warehouse/outbound-tower/contract";

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

export interface WarehouseCapacity {
  business_id: string;
  warehouse_id: string | null;
  generated_at: string;
  total_locations: number;
  active_locations: number;
  blocked_locations: number;
  quarantine_locations: number;
  quarantine_occupied: number;
  capacity_units: number;
  occupied_units: number;
  /** Null when no location in scope declares a capacity. */
  occupancy_pct: number | null;
  measured_locations: number;
  full_locations: number;
  empty_locations: number;
  staging_locations: number;
  staging_occupied: number;
  dock_count: number;
  dock_busy: number;
}

/* ------------------------------------------------------------------ */
/* Equipment                                                           */
/* ------------------------------------------------------------------ */

export type DeviceHealth = "online" | "stale" | "error" | "unknown";

export interface EquipmentDevice {
  id: string;
  name: string;
  role: string | null;
  transport: string | null;
  status: string | null;
  health: DeviceHealth;
  last_seen_at: string | null;
  last_error: string | null;
}

export interface EquipmentHealth {
  business_id: string;
  warehouse_id: string | null;
  generated_at: string;
  total: number;
  online: number;
  stale: number;
  error: number;
  unknown: number;
  /** Only the devices that are NOT online — the ones worth showing. */
  devices: EquipmentDevice[];
}

export const DEVICE_HEALTH_LABEL: Record<DeviceHealth, string> = {
  online: "Online",
  stale: "Not seen recently",
  error: "Error",
  unknown: "Never seen",
};

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

export interface ActivityEvent {
  id: string;
  event_type: string;
  source_doc_type: string | null;
  source_doc_id: string | null;
  warehouse_id: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Priority stack                                                      */
/* ------------------------------------------------------------------ */

export type PriorityOrigin = "flow" | "inbound" | "outbound";

export interface PriorityItem {
  key: string;
  origin: PriorityOrigin;
  reason_code: string;
  scope: string;
  reason: string;
  severity: number;
  impact_count: number;
  route: string;
}

export const ORIGIN_LABEL: Record<PriorityOrigin, string> = {
  flow: "Flow",
  inbound: "Inbound",
  outbound: "Outbound",
};

/**
 * Merges the three server-side bottleneck feeds into one ranked stack.
 *
 * The merge is pure presentation: severity and impact are decided in SQL,
 * this only orders them and de-duplicates the same cause reported by two
 * feeds (the flow spine and a tower can both see "no operator").
 */
export function rankPriorities(input: {
  flow?: Bottleneck[];
  inbound?: InboundBottleneck[];
  outbound?: OutboundBottleneck[];
}): PriorityItem[] {
  const items: PriorityItem[] = [
    ...(input.flow ?? []).map((b) => toItem(b, "flow")),
    ...(input.inbound ?? []).map((b) => toItem(b, "inbound")),
    ...(input.outbound ?? []).map((b) => toItem(b, "outbound")),
  ];

  const byCause = new Map<string, PriorityItem>();
  for (const item of items) {
    const cause = `${item.reason_code}|${item.scope}`;
    const existing = byCause.get(cause);
    if (
      !existing ||
      item.severity > existing.severity ||
      (item.severity === existing.severity && item.impact_count > existing.impact_count)
    ) {
      byCause.set(cause, item);
    }
  }

  return [...byCause.values()].sort(
    (a, b) => b.severity - a.severity || b.impact_count - a.impact_count,
  );
}

function toItem(
  b: Bottleneck | InboundBottleneck | OutboundBottleneck,
  origin: PriorityOrigin,
): PriorityItem {
  return {
    key: `${origin}:${b.reason_code}:${b.scope}`,
    origin,
    reason_code: b.reason_code as string,
    scope: b.scope,
    reason: b.reason,
    severity: b.severity,
    impact_count: b.impact_count,
    route: b.route,
  };
}
