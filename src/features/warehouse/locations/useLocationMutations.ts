/**
 * Location authoring mutations — create, update, retire and bulk-generate.
 *
 * Bulk generation goes through `wms_generate_locations` so the nesting
 * rules, code format and serpentine pick sequence are decided once, in the
 * database, for every caller (UI, import, seed).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { locationsQueryKey, overviewQueryKey } from "./useWarehouseLocations";
import type { StructureLevel } from "./types";

export interface LocationDraft {
  warehouse_id: string;
  parent_location_id: string | null;
  code: string;
  name: string;
  structure_level: StructureLevel;
  location_type?: string;
  usage?: string;
  barcode?: string | null;
  pick_sequence?: number | null;
  putaway_priority?: number | null;
  capacity_max_units?: number | null;
  capacity_max_weight?: number | null;
  is_active?: boolean;
  is_putaway_target?: boolean | null;
  is_receiving_staging?: boolean | null;
}

export interface GenerateSpec {
  warehouseId: string;
  parentId: string | null;
  level: StructureLevel;
  /** Codes are `${prefix}${padded index}` — e.g. A01, A02… */
  prefix: string;
  from: number;
  to: number;
  pad: number;
  serpentine: boolean;
  nameTemplate?: string;
}

export function useLocationMutations(warehouseId: string | null) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: locationsQueryKey(warehouseId) });
    void qc.invalidateQueries({ queryKey: overviewQueryKey(warehouseId) });
  };

  const create = useMutation({
    mutationFn: async (draft: LocationDraft) => {
      const { data, error } = await supabase
        .from("stock_locations")
        .insert(draft as never)
        .select("id")
        .single();
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: () => {
      invalidate();
      toast.success("Location added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<LocationDraft> }) => {
      const { error } = await supabase
        .from("stock_locations")
        .update(patch as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Location saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from("stock_locations")
        .update({ is_active: active } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      invalidate();
      toast.success(v.active ? "Location back in service" : "Location blocked");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const generate = useMutation({
    mutationFn: async (spec: GenerateSpec) => {
      const { data, error } = await supabase.rpc(
        "wms_generate_locations" as never,
        {
          p_warehouse_id: spec.warehouseId,
          p_parent_id: spec.parentId,
          p_level: spec.level,
          p_prefix: spec.prefix,
          p_from: spec.from,
          p_to: spec.to,
          p_pad: spec.pad,
          p_serpentine: spec.serpentine,
          p_name_template: spec.nameTemplate ?? null,
        } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as { id: string; code: string }[];
    },
    onSuccess: (rows) => {
      invalidate();
      toast.success(`${rows.length} location${rows.length === 1 ? "" : "s"} created`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { create, update, setActive, generate };
}
