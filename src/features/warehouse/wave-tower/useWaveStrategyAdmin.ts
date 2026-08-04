/**
 * Wave strategy administration — the write side of the planning engine.
 *
 * `wms_plan_waves` is driven entirely by `wms_wave_strategies` rows, so
 * without a way to author them the engine is inert. These mutations are the
 * only client write path; planning logic itself stays in SQL.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { WAVE_KEYS } from "./useWaveTower";
import type { WaveStrategy } from "./contract";

export type WaveStrategyDraft = Partial<WaveStrategy> & {
  warehouse_id: string;
  name: string;
  kind: string;
};

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: WAVE_KEYS.strategies });
    void qc.invalidateQueries({ queryKey: WAVE_KEYS.board });
  };
}

export function useSaveWaveStrategy() {
  const invalidate = useInvalidate();
  const { currentBusiness } = useBusinesses();
  return useMutation({
    mutationFn: async (draft: WaveStrategyDraft) => {
      const { id, ...rest } = draft;
      if (id) {
        const { error } = await supabase
          .from("wms_wave_strategies" as never)
          .update(rest as never)
          .eq("id", id);
        if (error) throw error;
        return id;
      }
      const { data, error } = await supabase
        .from("wms_wave_strategies" as never)
        .insert({
          ...rest,
          organization_id: currentBusiness?.organization_id ?? null,
          business_id: currentBusiness?.id ?? null,
        } as never)
        .select("id")
        .single();
      if (error) throw error;
      return (data as unknown as { id: string }).id;
    },
    onSuccess: () => {
      toast.success("Strategy saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useToggleWaveStrategy() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from("wms_wave_strategies" as never)
        .update({ is_active: isActive } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteWaveStrategy() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("wms_wave_strategies" as never)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Strategy removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Provision the standard express / carrier / zone strategy set. */
export function useSeedWaveStrategies() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (warehouseId: string) => {
      const { data, error } = await supabase.rpc(
        "wms_seed_default_wave_strategies" as never,
        { p_warehouse_id: warehouseId } as never,
      );
      if (error) throw error;
      return (data as unknown as number) ?? 0;
    },
    onSuccess: (n) => {
      toast.success(n > 0 ? `${n} default strategy(ies) added` : "Defaults already present");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
