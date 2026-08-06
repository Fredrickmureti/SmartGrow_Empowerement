/**
 * useLocationRecord — resolve a single location by id into the same
 * `LocationNode` (master + operational overlay + tree position) the layout
 * board works with.
 *
 * The workspace route only carries the location id, so this looks up the
 * owning warehouse first and then reuses `useWarehouseLocations` — one read
 * seam for the whole surface (ADR 0104), no parallel query shape.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useWarehouseLocations } from "./useWarehouseLocations";
import type { LocationNode } from "./types";

export function useLocationRecord(locationId: string | undefined) {
  const owner = useQuery({
    queryKey: ["wms-location-owner", locationId],
    enabled: !!locationId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, warehouse_id")
        .eq("id", locationId!)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; warehouse_id: string } | null;
    },
  });

  const warehouseId = owner.data?.warehouse_id ?? null;
  const tree = useWarehouseLocations(warehouseId);

  const node: LocationNode | null =
    locationId && tree.byId.get(locationId) ? tree.byId.get(locationId)! : null;

  return {
    node,
    warehouseId,
    ordered: tree.ordered,
    isLoading: owner.isLoading || (!!warehouseId && tree.isLoading),
    notFound: !owner.isLoading && !owner.data,
    refetch: tree.refetch,
  };
}
