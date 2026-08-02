/**
 * License Plate (LPN) operations layer — ADR 0079 handling units.
 *
 * Every plate mutation goes through a SECURITY DEFINER RPC so that stock
 * (`stock_quants.lpn_id`), the plate row, and the `wms_lpn_events` audit
 * trail move atomically. Pages never write `wms_license_plates` or
 * `stock_quants` directly for operational changes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type LpnType = "pallet" | "carton" | "tote" | "other";
export type LpnStatus = string;

export interface LpnOverviewRow {
  id: string;
  code: string;
  lpn_type: LpnType;
  status: LpnStatus;
  warehouse_id: string;
  current_location_id: string | null;
  parent_lpn_id: string | null;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
  row_version: number;
  location_code: string | null;
  location_name: string | null;
  warehouse_name: string | null;
  sku_count: number;
  total_quantity: number;
  child_count: number;
  notes: string | null;
}

export interface LpnContentRow {
  id: string;
  product_id: string;
  quantity: number;
  reserved_quantity: number | null;
  lot_number: string | null;
  products?: { name: string; sku: string | null } | null;
}

export interface LpnEventRow {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  quantity_delta: number | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  from_location_id: string | null;
  to_location_id: string | null;
  counterpart_lpn_id: string | null;
}

const sb = supabase as any;

export interface LpnFilters {
  businessId?: string | null;
  warehouseId?: string;
  type?: string;
  status?: string;
  search?: string;
  emptyOnly?: boolean;
}

export function useLpnOverview(filters: LpnFilters) {
  const { businessId, warehouseId = "all", type = "all", status = "all" } = filters;
  return useQuery({
    queryKey: ["wms-lpns", businessId, warehouseId, type, status],
    enabled: !!businessId,
    queryFn: async (): Promise<LpnOverviewRow[]> => {
      let q = sb
        .from("v_wms_lpn_overview")
        .select("*")
        .eq("business_id", businessId)
        .order("updated_at", { ascending: false })
        .limit(500);
      if (warehouseId !== "all") q = q.eq("warehouse_id", warehouseId);
      if (type !== "all") q = q.eq("lpn_type", type);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as LpnOverviewRow[];
    },
  });
}

export function useLpn(id: string | undefined) {
  return useQuery({
    queryKey: ["wms-lpn", id],
    enabled: !!id,
    queryFn: async (): Promise<LpnOverviewRow | null> => {
      const { data, error } = await sb
        .from("v_wms_lpn_overview")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as LpnOverviewRow | null;
    },
  });
}

export function useLpnContents(id: string | undefined) {
  return useQuery({
    queryKey: ["wms-lpn-contents", id],
    enabled: !!id,
    queryFn: async (): Promise<LpnContentRow[]> => {
      const { data, error } = await sb
        .from("stock_quants")
        .select("id, product_id, quantity, reserved_quantity, lot_number, products:product_id(name, sku)")
        .eq("lpn_id", id)
        .order("quantity", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as LpnContentRow[];
    },
  });
}

export function useLpnChildren(id: string | undefined) {
  return useQuery({
    queryKey: ["wms-lpn-children", id],
    enabled: !!id,
    queryFn: async (): Promise<LpnOverviewRow[]> => {
      const { data, error } = await sb
        .from("v_wms_lpn_overview")
        .select("*")
        .eq("parent_lpn_id", id)
        .order("code");
      if (error) throw error;
      return (data ?? []) as LpnOverviewRow[];
    },
  });
}

export function useLpnEvents(id: string | undefined, limit = 100) {
  return useQuery({
    queryKey: ["wms-lpn-events", id, limit],
    enabled: !!id,
    queryFn: async (): Promise<LpnEventRow[]> => {
      const { data, error } = await sb
        .from("wms_lpn_events")
        .select("*")
        .eq("lpn_id", id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as LpnEventRow[];
    },
  });
}

/** Resolve a scanned code to a plate in the active business. */
export async function resolveLpnByCode(businessId: string, code: string) {
  const { data, error } = await sb
    .from("v_wms_lpn_overview")
    .select("*")
    .eq("business_id", businessId)
    .ilike("code", code.trim())
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as LpnOverviewRow | null;
}

export async function nextLpnCode(businessId: string, warehouseId: string, lpnType: LpnType) {
  const { data, error } = await sb.rpc("wms_next_lpn_code", {
    _business_id: businessId,
    _warehouse_id: warehouseId,
    _lpn_type: lpnType,
  });
  if (error) throw error;
  return data as string;
}

/** Every plate mutation, keyed by operation. */
export function useLpnMutations(lpnId?: string) {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    qc.invalidateQueries({ queryKey: ["wms-lpn"] });
    qc.invalidateQueries({ queryKey: ["wms-lpn-contents"] });
    qc.invalidateQueries({ queryKey: ["wms-lpn-children"] });
    qc.invalidateQueries({ queryKey: ["wms-lpn-events"] });
  };

  function op<TVars>(
    fn: (vars: TVars) => Promise<void>,
    successMessage: string,
  ) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => {
        toast.success(successMessage);
        invalidate();
      },
      onError: (e: unknown) =>
        toast.error(e instanceof Error ? e.message : "Operation rejected"),
    });
  }

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { error } = await sb.rpc(name, args);
    if (error) throw error;
  };

  return {
    move: op<{ toLocationId: string; expectedVersion?: number; reason?: string }>(
      (v) =>
        rpc("wms_lpn_move", {
          _lpn_id: lpnId,
          _to_location_id: v.toLocationId,
          _expected_version: v.expectedVersion ?? null,
          _reason: v.reason ?? null,
        }),
      "Plate moved — stock relocated",
    ),
    load: op<{ productId: string; quantity: number; lotNumber?: string | null; serialNumber?: string | null }>(
      (v) =>
        rpc("wms_lpn_load", {
          _lpn_id: lpnId,
          _product_id: v.productId,
          _quantity: v.quantity,
          _lot_number: v.lotNumber ?? null,
          _serial_number: v.serialNumber ?? null,
        }),
      "Stock loaded onto plate",
    ),
    unload: op<{ productId: string; quantity: number; lotNumber?: string | null }>(
      (v) =>
        rpc("wms_lpn_unload", {
          _lpn_id: lpnId,
          _product_id: v.productId,
          _quantity: v.quantity,
          _lot_number: v.lotNumber ?? null,
        }),
      "Stock unloaded to bin",
    ),
    split: op<{ lines: Array<{ product_id: string; quantity: number; lot_number?: string | null }>; newType?: LpnType }>(
      (v) =>
        rpc("wms_lpn_split", {
          _lpn_id: lpnId,
          _lines: v.lines,
          _new_lpn_type: v.newType ?? null,
        }),
      "Plate split",
    ),
    merge: op<{ sourceIds: string[] }>(
      (v) =>
        rpc("wms_lpn_merge", {
          _source_lpn_ids: v.sourceIds,
          _target_lpn_id: lpnId,
        }),
      "Plates merged",
    ),
    nest: op<{ parentId: string }>(
      (v) => rpc("wms_lpn_nest", { _child_lpn_id: lpnId, _parent_lpn_id: v.parentId }),
      "Plate nested",
    ),
    unnest: op<void>(
      () => rpc("wms_lpn_unnest", { _child_lpn_id: lpnId }),
      "Plate detached",
    ),
    transition: op<{ toStatus: string; expectedVersion?: number; reason?: string }>(
      (v) =>
        rpc("wms_transition_lpn", {
          _lpn_id: lpnId,
          _to_status: v.toStatus,
          _expected_version: v.expectedVersion ?? 0,
          _reason: v.reason ?? null,
        }),
      "Plate status updated",
    ),
    invalidate,
  };
}
