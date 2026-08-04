/**
 * Putaway data hooks — the single read surface for strategy-driven
 * suggestions and the bin universe a supervisor may reassign to.
 *
 * Suggestions carry their provenance (`strategy`, `feasible_qty`, `score`)
 * because a putaway decision the floor cannot explain is a putaway decision
 * the floor will not trust.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PutawaySuggestion {
  id: string;
  location_id: string;
  rank: number;
  reason: string | null;
  strategy: string | null;
  feasible_qty: number | null;
  score: number | null;
  chosen: boolean | null;
  location: { code: string | null } | null;
}

export interface PutawayBin {
  id: string;
  code: string;
  storage_role: string | null;
  temp_regime: string | null;
  is_blocked: boolean | null;
}

export function usePutawaySuggestions(taskId: string | null) {
  return useQuery({
    queryKey: ["wms-putaway-suggestions", taskId],
    enabled: !!taskId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_putaway_suggestions")
        .select(
          "id, location_id, rank, reason, strategy, feasible_qty, score, chosen, location:location_id(code)",
        )
        .eq("task_id", taskId!)
        .order("rank");
      if (error) throw error;
      return (data ?? []) as unknown as PutawaySuggestion[];
    },
  });
}

export function usePutawayBins(warehouseId: string | null) {
  return useQuery({
    queryKey: ["wms-putaway-bins", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, code, storage_role, temp_regime, is_blocked")
        .eq("warehouse_id", warehouseId!)
        .eq("is_active", true)
        .order("code")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as PutawayBin[];
    },
  });
}