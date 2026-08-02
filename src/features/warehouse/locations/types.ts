/**
 * Warehouse location model — shared types for the Warehouse workspace
 * (ADR 0104). Inventory owns quantity and value; these types describe the
 * *physical* location master and the operational overlay computed by
 * `wms_location_overview`.
 */

export type StructureLevel =
  | "zone"
  | "aisle"
  | "rack"
  | "shelf"
  | "bin"
  | "dock"
  | "staging_in"
  | "staging_out";

export interface LocationRow {
  id: string;
  warehouse_id: string;
  parent_location_id: string | null;
  code: string;
  name: string;
  location_type: string;
  usage: string;
  structure_level: StructureLevel | null;
  barcode: string | null;
  pick_sequence: number | null;
  putaway_priority: number | null;
  capacity_max_units: number | null;
  capacity_max_weight: number | null;
  is_active: boolean;
  is_default: boolean;
  is_putaway_target: boolean | null;
  is_receiving_staging: boolean | null;
}

export interface LocationOverview {
  location_id: string;
  on_hand_units: number;
  reserved_units: number;
  sku_count: number;
  lot_count: number;
  direct_on_hand: number;
  capacity_units: number | null;
  occupancy_pct: number | null;
  open_tasks: number;
  putaway_tasks: number;
  pick_tasks: number;
  count_tasks: number;
  last_movement_at: string | null;
}

/** A location plus its operational overlay and tree position. */
export interface LocationNode extends LocationRow {
  children: LocationNode[];
  depth: number;
  path: string[];
  metrics: LocationOverview;
}

export const EMPTY_METRICS: LocationOverview = {
  location_id: "",
  on_hand_units: 0,
  reserved_units: 0,
  sku_count: 0,
  lot_count: 0,
  direct_on_hand: 0,
  capacity_units: null,
  occupancy_pct: null,
  open_tasks: 0,
  putaway_tasks: 0,
  pick_tasks: 0,
  count_tasks: 0,
  last_movement_at: null,
};

/** Operational state a supervisor scans the map for. */
export type LocationState = "blocked" | "full" | "busy" | "stocked" | "empty";

export function locationState(node: LocationNode): LocationState {
  if (!node.is_active) return "blocked";
  const occ = node.metrics.occupancy_pct;
  if (occ !== null && occ >= 95) return "full";
  if (node.metrics.open_tasks > 0) return "busy";
  if (node.metrics.on_hand_units > 0) return "stocked";
  return "empty";
}
