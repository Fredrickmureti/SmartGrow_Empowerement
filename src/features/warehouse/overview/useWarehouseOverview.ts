/**
 * Warehouse Overview — data access (ADR 0102).
 *
 * Three thin hooks over the three server-side aggregates the Overview
 * introduced (`wms_overview_capacity`, `wms_equipment_health`,
 * `wms_activity_feed`) plus the business-wide open exception ledger.
 *
 * Everything else the Overview renders comes from the owning module's hooks;
 * nothing is re-aggregated here. Query keys are registered in
 * `useWmsRealtimeSync`, so the board follows the floor with no polling.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { OPEN_STATES, type ExceptionRow } from "@/features/warehouse/exceptions/constants";
import type { ActivityEvent, EquipmentHealth, WarehouseCapacity } from "./contract";

export const OVERVIEW_KEYS = {
  capacity: ["wms-overview-capacity"] as const,
  equipment: ["wms-overview-equipment"] as const,
  activity: ["wms-overview-activity"] as const,
  exceptions: ["wms-overview-exceptions"] as const,
};

/** Every prefix the realtime channel must invalidate for the Overview. */
export const OVERVIEW_QUERY_PREFIXES = [
  OVERVIEW_KEYS.capacity,
  OVERVIEW_KEYS.equipment,
  OVERVIEW_KEYS.activity,
  OVERVIEW_KEYS.exceptions,
] as const;

type Scope = { warehouseId?: string };

function scopeArg(warehouseId?: string): string | null {
  return warehouseId && warehouseId !== "all" ? warehouseId : null;
}

export function useOverviewCapacity({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OVERVIEW_KEYS.capacity, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 30_000,
    queryFn: async (): Promise<WarehouseCapacity> => {
      const { data, error } = await supabase.rpc("wms_overview_capacity" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      } as never);
      if (error) throw error;
      return data as unknown as WarehouseCapacity;
    },
  });
}

export function useEquipmentHealth({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OVERVIEW_KEYS.equipment, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 30_000,
    queryFn: async (): Promise<EquipmentHealth> => {
      const { data, error } = await supabase.rpc("wms_equipment_health" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      } as never);
      if (error) throw error;
      return data as unknown as EquipmentHealth;
    },
  });
}

/**
 * The live floor feed.
 *
 * Reads `business_event_outbox` through an RPC rather than a table query so
 * the Overview honours the rule that only `<OutboxTimeline />` may touch the
 * outbox table directly, and so the topic filter stays server-side.
 */
export function useActivityFeed({ warehouseId, limit = 40 }: Scope & { limit?: number } = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OVERVIEW_KEYS.activity, businessId, warehouseId ?? "all", limit],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<ActivityEvent[]> => {
      const { data, error } = await supabase.rpc("wms_activity_feed" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
        p_limit: limit,
      } as never);
      if (error) throw error;
      return (data as unknown as ActivityEvent[]) ?? [];
    },
  });
}

/** Open exceptions across the whole warehouse, severity first. */
export function useOverviewExceptions({ warehouseId, limit = 8 }: Scope & { limit?: number } = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OVERVIEW_KEYS.exceptions, businessId, warehouseId ?? "all", limit],
    enabled: !!businessId,
    staleTime: 15_000,
    queryFn: async (): Promise<ExceptionRow[]> => {
      let q = supabase
        .from("wms_exceptions")
        .select("*")
        .eq("business_id", businessId!)
        .in("state", OPEN_STATES)
        .order("severity", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(limit);
      const wh = scopeArg(warehouseId);
      if (wh) q = q.eq("warehouse_id", wh);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ExceptionRow[];
    },
  });
}
