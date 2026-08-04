/**
 * Supervisor Control Center — data access.
 *
 * Three thin hooks over the server-side health contract. There is no
 * client-side aggregation of task rows here by design: the control center
 * must be able to run over a warehouse with hundreds of thousands of open
 * tasks, and the same numbers have to be reachable from mobile and from
 * alerting without duplicating the rules.
 *
 * Query keys are registered in `useWmsRealtimeSync` so the board follows
 * the floor with no polling and no manual refresh.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import type { Bottleneck, FlowHealth, ZoneLoad } from "./contract";

export const CONTROL_CENTER_KEYS = {
  health: ["wms-flow-health"] as const,
  bottlenecks: ["wms-flow-bottlenecks"] as const,
  zones: ["wms-zone-load"] as const,
};

type Scope = { warehouseId?: string };

function scopeArg(warehouseId?: string): string | null {
  return warehouseId && warehouseId !== "all" ? warehouseId : null;
}

export function useFlowHealth({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...CONTROL_CENTER_KEYS.health, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    // The floor moves continuously; a stale board is a wrong board.
    staleTime: 10_000,
    queryFn: async (): Promise<FlowHealth> => {
      const { data, error } = await supabase.rpc("wms_flow_health", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      });
      if (error) throw error;
      return data as unknown as FlowHealth;
    },
  });
}

export function useFlowBottlenecks({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...CONTROL_CENTER_KEYS.bottlenecks, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<Bottleneck[]> => {
      const { data, error } = await supabase.rpc("wms_flow_bottlenecks", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      });
      if (error) throw error;
      return ((data as unknown as { bottlenecks: Bottleneck[] })?.bottlenecks ?? []);
    },
  });
}

export function useZoneLoad({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...CONTROL_CENTER_KEYS.zones, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 15_000,
    queryFn: async (): Promise<ZoneLoad[]> => {
      const { data, error } = await supabase.rpc("wms_zone_load", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      });
      if (error) throw error;
      return ((data as unknown as { zones: ZoneLoad[] })?.zones ?? []);
    },
  });
}

/**
 * Slices the stage chain for the role-specific towers so inbound and
 * outbound consume the SAME contract as the supervisor board instead of
 * re-implementing their own aggregation.
 */
export const INBOUND_STAGES = ["receive", "inspect", "putaway", "store"] as const;
export const OUTBOUND_STAGES = ["replenish", "pick", "pack", "load", "dispatch"] as const;
