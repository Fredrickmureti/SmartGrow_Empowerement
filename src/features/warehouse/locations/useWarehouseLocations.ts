/**
 * useWarehouseLocations — the single read seam for the Warehouse layout
 * workspace (ADR 0104).
 *
 * Combines the location master (`stock_locations`) with the operational
 * overlay (`wms_location_overview`: on-hand, reserved, SKUs, lots,
 * occupancy, open tasks, last movement — rolled up the tree) and returns a
 * ready-to-render node tree plus lookup indexes.
 *
 * Inventory remains canonical for quantity and value; this hook never
 * writes stock.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  EMPTY_METRICS,
  type LocationNode,
  type LocationOverview,
  type LocationRow,
} from "./types";

const SELECT =
  "id, warehouse_id, parent_location_id, code, name, location_type, usage, structure_level, barcode, pick_sequence, putaway_priority, capacity_max_units, capacity_max_weight, is_active, is_default, is_putaway_target, is_receiving_staging";

export function locationsQueryKey(warehouseId: string | null) {
  return ["wms-locations", warehouseId] as const;
}

export function overviewQueryKey(warehouseId: string | null) {
  return ["wms-location-overview", warehouseId] as const;
}

export interface WarehouseLocationsResult {
  roots: LocationNode[];
  /** Every node, depth-first, in physical (pick-sequence) order. */
  ordered: LocationNode[];
  byId: Map<string, LocationNode>;
  byCode: Map<string, LocationNode>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useWarehouseLocations(warehouseId: string | null): WarehouseLocationsResult {
  const locations = useQuery({
    queryKey: locationsQueryKey(warehouseId),
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select(SELECT)
        .eq("warehouse_id", warehouseId!)
        .order("code");
      if (error) throw error;
      return (data ?? []) as unknown as LocationRow[];
    },
  });

  const overview = useQuery({
    queryKey: overviewQueryKey(warehouseId),
    enabled: !!warehouseId,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "wms_location_overview" as never,
        { p_warehouse_id: warehouseId } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as LocationOverview[];
    },
  });

  const built = useMemo(() => {
    const rows = locations.data ?? [];
    const metrics = new Map<string, LocationOverview>();
    (overview.data ?? []).forEach((m) => metrics.set(m.location_id, m));

    const byId = new Map<string, LocationNode>();
    rows.forEach((r) =>
      byId.set(r.id, {
        ...r,
        children: [],
        depth: 0,
        path: [],
        metrics: metrics.get(r.id) ?? { ...EMPTY_METRICS, location_id: r.id },
      }),
    );

    const roots: LocationNode[] = [];
    byId.forEach((node) => {
      const parent = node.parent_location_id ? byId.get(node.parent_location_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    });

    const sortNodes = (nodes: LocationNode[]) => {
      nodes.sort((a, b) => {
        const sa = a.pick_sequence ?? Number.MAX_SAFE_INTEGER;
        const sb = b.pick_sequence ?? Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return a.code.localeCompare(b.code, undefined, { numeric: true });
      });
      nodes.forEach((n) => sortNodes(n.children));
    };
    sortNodes(roots);

    const ordered: LocationNode[] = [];
    const byCode = new Map<string, LocationNode>();
    const walk = (nodes: LocationNode[], depth: number, path: string[]) => {
      nodes.forEach((n) => {
        n.depth = depth;
        n.path = [...path, n.code];
        ordered.push(n);
        byCode.set(n.code.toUpperCase(), n);
        walk(n.children, depth + 1, n.path);
      });
    };
    walk(roots, 0, []);

    return { roots, ordered, byId, byCode };
  }, [locations.data, overview.data]);

  return {
    ...built,
    isLoading: locations.isLoading,
    isError: locations.isError,
    refetch: () => {
      void locations.refetch();
      void overview.refetch();
    },
  };
}
