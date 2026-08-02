/**
 * Location authoring mutations — create, update, retire, move and
 * bulk-generate.
 *
 * Bulk generation goes through `wms_generate_locations` so the nesting
 * rules, code format and serpentine walk order are decided once, in the
 * database, for every caller (UI, import, seed). The same function in
 * dry-run mode powers the designer's live preview, so what a supervisor
 * sees before committing is produced by the code that will do the work.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";
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

/** One tier of a generated run, outermost first. */
export interface LevelSpec {
  level: StructureLevel;
  count: number;
  prefix: string;
  pad: number;
}

export interface GenerateSpec {
  warehouseId: string;
  parentId: string | null;
  levels: LevelSpec[];
  separator?: string;
  /** Code prefix used when generating at the warehouse root. */
  codePrefix?: string | null;
  serpentine: boolean;
  /** Capacity stamped on generated bins. */
  capacity?: number | null;
  barcodeAuto: boolean;
}

export interface GeneratedRow {
  code: string;
  level: string;
  created: boolean;
}

function rpcArgs(spec: GenerateSpec, dryRun: boolean) {
  return {
    p_warehouse_id: spec.warehouseId,
    p_parent_id: spec.parentId,
    p_levels: spec.levels.map((l) => ({
      level: l.level,
      count: l.count,
      prefix: l.prefix,
      pad: l.pad,
    })),
    p_separator: spec.separator ?? "-",
    p_code_prefix: spec.codePrefix ?? null,
    p_serpentine: spec.serpentine,
    p_capacity: spec.capacity ?? null,
    p_barcode_auto: spec.barcodeAuto,
    p_dry_run: dryRun,
  };
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
    onError: (e: unknown) => {
      const n = normalizeError(e);
      toast.error(n.title, { description: n.message });
    },
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
    onError: (e: unknown) => {
      const n = normalizeError(e);
      toast.error(n.title, { description: n.message });
    },
  });

  /**
   * Re-parent a location. Legal nesting and the "can't move something that
   * holds stock or open work" rule are enforced by the database trigger —
   * this only carries the intent.
   */
  const move = useMutation({
    mutationFn: async ({ id, parentId }: { id: string; parentId: string | null }) => {
      const { error } = await supabase
        .from("stock_locations")
        .update({ parent_location_id: parentId } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Location moved");
    },
    onError: (e: unknown) => {
      const n = normalizeError(e);
      toast.error(n.title, { description: n.message });
    },
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
    onError: (e: unknown) => {
      const n = normalizeError(e);
      toast.error(n.title, { description: n.message });
    },
  });

  const generate = useMutation({
    mutationFn: async (spec: GenerateSpec) => {
      const { data, error } = await supabase.rpc(
        "wms_generate_locations" as never,
        rpcArgs(spec, false) as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as GeneratedRow[];
    },
    onSuccess: (rows) => {
      invalidate();
      const made = rows.filter((r) => r.created).length;
      const skipped = rows.length - made;
      toast.success(`${made} location${made === 1 ? "" : "s"} created`, {
        description: skipped > 0 ? `${skipped} already existed and were left alone.` : undefined,
      });
    },
    onError: (e: unknown) => {
      const n = normalizeError(e);
      toast.error(n.title, { description: n.message });
    },
  });

  /**
   * Dry run — returns exactly the codes the commit would create, produced
   * by the same SQL. Never writes.
   */
  const preview = useCallback(async (spec: GenerateSpec): Promise<GeneratedRow[]> => {
    const { data, error } = await supabase.rpc(
      "wms_generate_locations" as never,
      rpcArgs(spec, true) as never,
    );
    if (error) throw error;
    return (data ?? []) as unknown as GeneratedRow[];
  }, []);

  return { create, update, move, setActive, generate, preview };
}
