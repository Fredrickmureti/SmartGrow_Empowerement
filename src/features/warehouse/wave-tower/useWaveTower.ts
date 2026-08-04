/**
 * Wave Control Tower — data access.
 *
 * Thin hooks over the server-side wave contract. There is no client-side
 * aggregation by design: the tower, the RF shell and alerting must all read
 * the same verdict, and a site running hundreds of concurrent waves cannot
 * afford to re-derive readiness in a browser.
 *
 * Every query key here is registered in `useWmsRealtimeSync`, so the board
 * follows the floor — releases, picks, packs, exceptions — with no polling.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import type {
  WaveBoardRow, WaveCapacity, WaveDemandRow, WaveHealth, WaveStrategy,
} from "./contract";

export const WAVE_KEYS = {
  health: ["wms-wave-health"] as const,
  board: ["wms-wave-board"] as const,
  demand: ["wms-wave-demand"] as const,
  strategies: ["wms-wave-strategies"] as const,
  capacity: ["wms-wave-capacity"] as const,
};

/** Every prefix the realtime channel must invalidate for the tower. */
export const WAVE_QUERY_PREFIXES = [
  WAVE_KEYS.health,
  WAVE_KEYS.board,
  WAVE_KEYS.demand,
  WAVE_KEYS.strategies,
  WAVE_KEYS.capacity,
] as const;

type Scope = { warehouseId?: string };

function scopeArg(warehouseId?: string): string | null {
  return warehouseId && warehouseId !== "all" ? warehouseId : null;
}

export function useWaveHealth({ warehouseId }: Scope = {}) {
  const wh = scopeArg(warehouseId);
  return useQuery({
    queryKey: [...WAVE_KEYS.health, wh ?? "none"],
    enabled: !!wh,
    staleTime: 10_000,
    queryFn: async (): Promise<WaveHealth> => {
      const { data, error } = await supabase.rpc("wms_wave_health" as never, {
        p_warehouse_id: wh!,
      } as never);
      if (error) throw error;
      return data as unknown as WaveHealth;
    },
  });
}

export function useWaveBoard({ warehouseId, includeClosed = false }: Scope & { includeClosed?: boolean } = {}) {
  const wh = scopeArg(warehouseId);
  return useQuery({
    queryKey: [...WAVE_KEYS.board, wh ?? "none", includeClosed],
    enabled: !!wh,
    staleTime: 10_000,
    queryFn: async (): Promise<WaveBoardRow[]> => {
      const { data, error } = await supabase.rpc("wms_wave_board" as never, {
        p_warehouse_id: wh!,
        p_include_closed: includeClosed,
      } as never);
      if (error) throw error;
      return (data as unknown as WaveBoardRow[]) ?? [];
    },
  });
}

/**
 * Outbound demand — every open order line waiting for a wave, with the
 * server's eligibility verdict. The page never decides what is waveable.
 */
export function useWaveDemand({ warehouseId }: Scope = {}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: [...WAVE_KEYS.demand, businessId, warehouseId ?? "all"],
    enabled: !!businessId,
    staleTime: 15_000,
    queryFn: async (): Promise<WaveDemandRow[]> => {
      const { data, error } = await supabase.rpc("wms_wave_demand" as never, {
        p_business_id: businessId!,
        p_warehouse_id: scopeArg(warehouseId),
      } as never);
      if (error) throw error;
      return (data as unknown as WaveDemandRow[]) ?? [];
    },
  });
}

export function useWaveStrategies({ warehouseId }: Scope = {}) {
  const wh = scopeArg(warehouseId);
  return useQuery({
    queryKey: [...WAVE_KEYS.strategies, wh ?? "none"],
    enabled: !!wh,
    staleTime: 60_000,
    queryFn: async (): Promise<WaveStrategy[]> => {
      const { data, error } = await supabase
        .from("wms_wave_strategies" as never)
        .select("*")
        .eq("warehouse_id", wh!)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return (data as unknown as WaveStrategy[]) ?? [];
    },
  });
}

/**
 * Shift capacity for the selected warehouse — operators on shift, minutes
 * available, minutes already committed, minutes the wave plan will consume.
 * Computed by `wms_wave_capacity`; the page never divides anything.
 */
export function useWaveCapacity({ warehouseId }: Scope = {}) {
  const wh = scopeArg(warehouseId);
  return useQuery({
    queryKey: [...WAVE_KEYS.capacity, wh ?? "none"],
    enabled: !!wh,
    staleTime: 30_000,
    queryFn: async (): Promise<WaveCapacity> => {
      const { data, error } = await supabase.rpc("wms_wave_capacity" as never, {
        p_warehouse_id: wh!,
      } as never);
      if (error) throw error;
      return data as unknown as WaveCapacity;
    },
  });
}
