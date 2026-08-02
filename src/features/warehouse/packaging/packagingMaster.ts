/**
 * Packaging Master — client seam for the catalogue (ADR 0105, Phase 7).
 *
 * READS go straight at the master tables (they are SELECT-only for the
 * `authenticated` role). WRITES go exclusively through the sanctioned
 * SECURITY DEFINER RPCs — the client has no INSERT/UPDATE/DELETE grant on
 * `wms_packaging_types`, `wms_packaging_carriers` or
 * `wms_packaging_availability`, so any direct `.insert()` here would fail
 * at the database, by design. Optimistic concurrency rides on
 * `row_version`; a stale save surfaces `WMS_PKG_STALE`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type PackagingClass = Database["public"]["Enums"]["wms_packaging_class"];
export type PackagingLifecycle = Database["public"]["Enums"]["wms_packaging_lifecycle"];
export type PackagingType = Database["public"]["Tables"]["wms_packaging_types"]["Row"];
export type PackagingCarrierRule =
  Database["public"]["Tables"]["wms_packaging_carriers"]["Row"];
export type PackagingAvailability =
  Database["public"]["Tables"]["wms_packaging_availability"]["Row"];

export const PACKAGING_CLASSES: PackagingClass[] = [
  "carton",
  "envelope",
  "tube",
  "crate",
  "pallet",
  "tote",
  "insulated",
  "drum",
  "bag",
];

export const PACKAGING_LIFECYCLES: PackagingLifecycle[] = [
  "draft",
  "active",
  "restricted",
  "retired",
];

export const LIFECYCLE_TONE: Record<
  PackagingLifecycle,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "info",
  active: "success",
  restricted: "warning",
  retired: "neutral",
};

/** Payload accepted by `wms_packaging_upsert` — mirrors the RPC contract. */
export interface PackagingUpsertPayload {
  code?: string;
  name?: string;
  packaging_class?: PackagingClass;
  material?: string | null;
  inner_length_cm?: number;
  inner_width_cm?: number;
  inner_height_cm?: number;
  outer_length_cm?: number | null;
  outer_width_cm?: number | null;
  outer_height_cm?: number | null;
  max_weight_kg?: number;
  tare_weight_kg?: number;
  max_volume_fill_pct?: number;
  dim_weight_divisor?: number | null;
  is_returnable?: boolean;
  is_stackable?: boolean;
  nest_ratio?: number | null;
  units_per_layer?: number | null;
  layers_per_unit?: number | null;
  hazmat_class?: string | null;
  un_rating?: string | null;
  temp_min_c?: number | null;
  temp_max_c?: number | null;
  cost?: number;
  lifecycle_status?: PackagingLifecycle;
  notes?: string | null;
}

const KEYS = {
  list: (businessId?: string) => ["wms-packaging-types", businessId] as const,
  carriers: (id?: string) => ["wms-packaging-carriers", id] as const,
  availability: (id?: string) => ["wms-packaging-availability", id] as const,
  events: (id?: string) => ["wms-packaging-events", id] as const,
};

/** Usable interior volume in cm³, honouring the fill cap the engine applies. */
export function usableVolumeCm3(row: PackagingType): number {
  const gross = row.inner_length_cm * row.inner_width_cm * row.inner_height_cm;
  return (gross * (row.max_volume_fill_pct ?? 100)) / 100;
}

/** Dimensional weight in kg for the outer (or inner) footprint. */
export function dimWeightKg(row: PackagingType): number | null {
  const divisor = row.dim_weight_divisor;
  if (!divisor) return null;
  const l = row.outer_length_cm ?? row.inner_length_cm;
  const w = row.outer_width_cm ?? row.inner_width_cm;
  const h = row.outer_height_cm ?? row.inner_height_cm;
  return (l * w * h) / divisor;
}

export function usePackagingTypes(businessId?: string) {
  return useQuery({
    queryKey: KEYS.list(businessId),
    enabled: !!businessId,
    queryFn: async (): Promise<PackagingType[]> => {
      const { data, error } = await supabase
        .from("wms_packaging_types")
        .select("*")
        .eq("business_id", businessId!)
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePackagingCarrierRules(packagingTypeId?: string) {
  return useQuery({
    queryKey: KEYS.carriers(packagingTypeId),
    enabled: !!packagingTypeId,
    queryFn: async (): Promise<PackagingCarrierRule[]> => {
      const { data, error } = await supabase
        .from("wms_packaging_carriers")
        .select("*")
        .eq("packaging_type_id", packagingTypeId!);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePackagingAvailability(packagingTypeId?: string) {
  return useQuery({
    queryKey: KEYS.availability(packagingTypeId),
    enabled: !!packagingTypeId,
    queryFn: async (): Promise<PackagingAvailability[]> => {
      const { data, error } = await supabase
        .from("wms_packaging_availability")
        .select("*")
        .eq("packaging_type_id", packagingTypeId!);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export interface PackagingEventRow {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  qty_delta: number | null;
  created_at: string;
}

export function usePackagingEvents(packagingTypeId?: string) {
  return useQuery({
    queryKey: KEYS.events(packagingTypeId),
    enabled: !!packagingTypeId,
    queryFn: async (): Promise<PackagingEventRow[]> => {
      const { data, error } = await supabase
        .from("wms_packaging_events")
        .select("id,event_type,from_status,to_status,reason,qty_delta,created_at")
        .eq("packaging_type_id", packagingTypeId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as PackagingEventRow[];
    },
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return (packagingTypeId?: string) => {
    qc.invalidateQueries({ queryKey: ["wms-packaging-types"] });
    if (packagingTypeId) {
      qc.invalidateQueries({ queryKey: KEYS.carriers(packagingTypeId) });
      qc.invalidateQueries({ queryKey: KEYS.availability(packagingTypeId) });
      qc.invalidateQueries({ queryKey: KEYS.events(packagingTypeId) });
    }
  };
}

export function useUpsertPackaging(businessId?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      id?: string | null;
      rowVersion?: number | null;
      payload: PackagingUpsertPayload;
    }): Promise<PackagingType> => {
      if (!businessId) throw new Error("No active business");
      const { data, error } = await supabase.rpc("wms_packaging_upsert", {
        p_business_id: businessId,
        p_payload: input.payload as never,
        p_id: input.id ?? undefined,
        p_row_version: input.rowVersion ?? undefined,
      });
      if (error) throw error;
      return data as unknown as PackagingType;
    },
    onSuccess: (row) => invalidate(row?.id),
  });
}

export function useSetPackagingLifecycle() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: PackagingLifecycle;
      reason?: string | null;
      rowVersion?: number | null;
    }): Promise<PackagingType> => {
      const { data, error } = await supabase.rpc("wms_packaging_set_lifecycle", {
        p_id: input.id,
        p_status: input.status,
        p_reason: input.reason ?? undefined,
        p_row_version: input.rowVersion ?? undefined,
      });
      if (error) throw error;
      return data as unknown as PackagingType;
    },
    onSuccess: (row) => invalidate(row?.id),
  });
}

export interface PackagingArchiveResult {
  deleted: boolean;
  retired: boolean;
  usage_count: number;
}

export function useArchivePackaging() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      reason?: string | null;
    }): Promise<PackagingArchiveResult> => {
      const { data, error } = await supabase.rpc("wms_packaging_archive", {
        p_id: input.id,
        p_reason: input.reason ?? undefined,
      });
      if (error) throw error;
      return data as unknown as PackagingArchiveResult;
    },
    onSuccess: (_r, vars) => invalidate(vars.id),
  });
}

export function useSetPackagingCarrierRule() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      packagingTypeId: string;
      carrierId: string;
      serviceCode?: string | null;
      isAllowed: boolean;
      isOversize: boolean;
      surchargeAmount: number;
      dimWeightDivisor?: number | null;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("wms_packaging_set_carrier_rule", {
        p_packaging_type_id: input.packagingTypeId,
        p_carrier_id: input.carrierId,
        p_service_code: input.serviceCode ?? undefined,
        p_is_allowed: input.isAllowed,
        p_is_oversize: input.isOversize,
        p_surcharge_amount: input.surchargeAmount,
        p_dim_weight_divisor: input.dimWeightDivisor ?? undefined,
        p_notes: input.notes ?? undefined,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_r, vars) => invalidate(vars.packagingTypeId),
  });
}

export function useSetPackagingAvailability() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      packagingTypeId: string;
      warehouseId: string;
      qtyOnHand?: number | null;
      reorderPoint?: number | null;
      isStocked: boolean;
    }) => {
      const { data, error } = await supabase.rpc("wms_packaging_set_availability", {
        p_packaging_type_id: input.packagingTypeId,
        p_warehouse_id: input.warehouseId,
        p_qty_on_hand: input.qtyOnHand ?? undefined,
        p_reorder_point: input.reorderPoint ?? undefined,
        p_is_stocked: input.isStocked,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_r, vars) => invalidate(vars.packagingTypeId),
  });
}

/** Maps a raw Postgres error into operator language. */
export function packagingErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("WMS_PKG_STALE"))
    return "This packaging type was changed by someone else. Reload and re-apply your edit.";
  if (msg.includes("WMS_PKG_IN_USE"))
    return "Open cartons still use this packaging — seal or reassign them before retiring it.";
  if (msg.includes("WMS_PKG_FORBIDDEN"))
    return "You do not have inventory write access for this business.";
  if (msg.includes("WMS_PKG_NOT_FOUND")) return "That packaging type no longer exists.";
  if (msg.includes("duplicate key")) return "That packaging code is already in use.";
  return msg;
}
