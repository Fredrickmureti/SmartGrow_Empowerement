/**
 * Outbound Control Tower — data access.
 *
 * Four thin hooks over the server-side outbound contract. There is no
 * client-side aggregation by design: the tower must stay correct on a
 * warehouse running thousands of concurrent loads, and the same numbers have
 * to be reachable from mobile and from alerting without duplicating rules.
 *
 * Every query key is registered in `useWmsRealtimeSync`, so the board follows
 * the floor — including scanner and printer driven state changes, which land
 * as rows on the same tables — with no polling.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { OPEN_STATES, type ExceptionRow } from "@/features/warehouse/exceptions/constants";
import type {
  DockBoard, OutboundBottleneck, OutboundHealth, OutboundShipment,
} from "./contract";

export const OUTBOUND_KEYS = {
  health: ["wms-outbound-health"] as const,
  shipments: ["wms-outbound-shipments"] as const,
  bottlenecks: ["wms-outbound-bottlenecks"] as const,
  dockBoard: ["wms-outbound-dock-board"] as const,
  exceptions: ["wms-outbound-exceptions"] as const,
};

/** Every prefix the realtime channel must invalidate for the tower. */
export const OUTBOUND_QUERY_PREFIXES = [
  OUTBOUND_KEYS.health,
  OUTBOUND_KEYS.shipments,
  OUTBOUND_KEYS.bottlenecks,
  OUTBOUND_KEYS.dockBoard,
  OUTBOUND_KEYS.exceptions,
] as const;

type Scope = { warehouseId?: string };

function scopeArg(warehouseId?: string): string | null {
  return warehouseId && warehouseId !== "all" ? warehouseId : null;
}

export function useOutboundHealth({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OUTBOUND_KEYS.health, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<OutboundHealth> => {
      const { data, error } = await supabase.rpc("wms_outbound_health", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      });
      if (error) throw error;
      return data as unknown as OutboundHealth;
    },
  });
}

export function useOutboundShipments({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OUTBOUND_KEYS.shipments, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<OutboundShipment[]> => {
      const { data, error } = await supabase.rpc("wms_outbound_shipments", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
        p_limit: 200,
      });
      if (error) throw error;
      return ((data as unknown as { shipments: OutboundShipment[] })?.shipments ?? []);
    },
  });
}

export function useOutboundBottlenecks({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OUTBOUND_KEYS.bottlenecks, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<OutboundBottleneck[]> => {
      const { data, error } = await supabase.rpc("wms_outbound_bottlenecks", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      });
      if (error) throw error;
      return ((data as unknown as { bottlenecks: OutboundBottleneck[] })?.bottlenecks ?? []);
    },
  });
}

export function useOutboundDockBoard({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OUTBOUND_KEYS.dockBoard, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 15_000,
    queryFn: async (): Promise<DockBoard> => {
      const { data, error } = await supabase.rpc("wms_outbound_dock_board", {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      });
      if (error) throw error;
      return data as unknown as DockBoard;
    },
  });
}

/**
 * Open outbound exceptions for the rail.
 *
 * Reads the platform exception ledger directly — the tower never forks the
 * exception model — scoped to the active company and, when chosen, the
 * warehouse. Triage still belongs to the exceptions inbox.
 */
export function useOutboundExceptions({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...OUTBOUND_KEYS.exceptions, businessId, warehouseId ?? "all"],
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
        .limit(25);
      const wh = scopeArg(warehouseId);
      if (wh) q = q.eq("warehouse_id", wh);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ExceptionRow[];
    },
  });
}
