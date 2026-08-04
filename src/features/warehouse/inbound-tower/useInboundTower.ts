/**
 * Inbound Control Tower — data access.
 *
 * Four thin hooks over the server-side inbound contract plus the shared
 * exception ledger. There is no client-side aggregation by design: the same
 * numbers must be reachable from mobile and from alerting without
 * duplicating rules, and the tower has to stay correct on a site running
 * hundreds of concurrent receipts.
 *
 * Every query key is registered in `useWmsRealtimeSync`, so the board
 * follows the floor — gate scans, dock moves, receiving captures, QC
 * decisions — with no polling.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { OPEN_STATES, type ExceptionRow } from "@/features/warehouse/exceptions/constants";
import type {
  InboundArrival, InboundBottleneck, InboundDockBoard, InboundHealth,
} from "./contract";

export const INBOUND_KEYS = {
  health: ["wms-inbound-health"] as const,
  arrivals: ["wms-inbound-arrivals"] as const,
  bottlenecks: ["wms-inbound-bottlenecks"] as const,
  dockBoard: ["wms-inbound-dock-board"] as const,
  exceptions: ["wms-inbound-exceptions"] as const,
};

/** Every prefix the realtime channel must invalidate for the tower. */
export const INBOUND_QUERY_PREFIXES = [
  INBOUND_KEYS.health,
  INBOUND_KEYS.arrivals,
  INBOUND_KEYS.bottlenecks,
  INBOUND_KEYS.dockBoard,
  INBOUND_KEYS.exceptions,
] as const;

type Scope = { warehouseId?: string };

function scopeArg(warehouseId?: string): string | null {
  return warehouseId && warehouseId !== "all" ? warehouseId : null;
}

export function useInboundHealth({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...INBOUND_KEYS.health, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<InboundHealth> => {
      const { data, error } = await supabase.rpc("wms_inbound_health" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      } as never);
      if (error) throw error;
      return data as unknown as InboundHealth;
    },
  });
}

export function useInboundArrivals({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...INBOUND_KEYS.arrivals, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<InboundArrival[]> => {
      const { data, error } = await supabase.rpc("wms_inbound_arrivals" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
        p_limit: 200,
      } as never);
      if (error) throw error;
      return ((data as unknown as { arrivals: InboundArrival[] })?.arrivals ?? []);
    },
  });
}

export function useInboundBottlenecks({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...INBOUND_KEYS.bottlenecks, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 10_000,
    queryFn: async (): Promise<InboundBottleneck[]> => {
      const { data, error } = await supabase.rpc("wms_inbound_bottlenecks" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      } as never);
      if (error) throw error;
      return (data as unknown as InboundBottleneck[]) ?? [];
    },
  });
}

export function useInboundDockBoard({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...INBOUND_KEYS.dockBoard, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 15_000,
    queryFn: async (): Promise<InboundDockBoard> => {
      const { data, error } = await supabase.rpc("wms_inbound_dock_board" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      } as never);
      if (error) throw error;
      return data as unknown as InboundDockBoard;
    },
  });
}

/**
 * Open exceptions for the inbound rail.
 *
 * Reads the platform exception ledger directly — the tower never forks the
 * exception model, and it never classifies exception text in the client;
 * the inbound taxonomy lives in `wms_inbound_bottlenecks`. Triage stays with
 * the exceptions inbox.
 */
export function useInboundExceptions({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...INBOUND_KEYS.exceptions, businessId, warehouseId ?? "all"],
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
