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
  organization_id: string;
  business_id: string;
  branch_id: string | null;
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

/**
 * A legal status change, as declared by the database rulebook
 * (`wms_lpn_status_edges`). The UI never hardcodes lifecycle rules — it
 * renders exactly the edges the FSM will accept.
 */
export interface LpnStatusEdge {
  from_status: string;
  to_status: string;
  verb: string;
  description: string | null;
  requires_reason: boolean;
  rpc_name: string | null;
  sort_order: number;
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

/**
 * Resolve a scanned/typed plate code to its row within one business.
 * Codes are unique per business, so a scan never has to guess a warehouse.
 */
export async function resolveLpnByCode(
  businessId: string,
  code: string,
): Promise<LpnOverviewRow | null> {
  const { data, error } = await sb
    .from("v_wms_lpn_overview")
    .select("*")
    .eq("business_id", businessId)
    .ilike("code", code.trim())
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as LpnOverviewRow | null;
}

function _useLpnUnused(id: string | undefined) {
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

/** Legal transitions out of a status, straight from the FSM edge table. */
export function useLpnAllowedTransitions(status: string | undefined) {
  return useQuery({
    queryKey: ["wms-lpn-edges", status],
    enabled: !!status,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LpnStatusEdge[]> => {
      const { data, error } = await sb
        .from("wms_lpn_status_edges")
        .select("from_status, to_status, verb, description, requires_reason, rpc_name, sort_order")
        .eq("from_status", status)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as LpnStatusEdge[];
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

/** Operations available on a plate. */
export type LpnAction =
  | { kind: "move"; toLocationId: string; expectedVersion?: number | null; reason?: string | null }
  | { kind: "load"; productId: string; quantity: number; lotNumber?: string | null; serialNumber?: string | null }
  | { kind: "unload"; productId: string; quantity: number; lotNumber?: string | null }
  | { kind: "split"; lines: Array<{ product_id: string; quantity: number; lot_number?: string | null }>; newType?: LpnType | null }
  | { kind: "merge"; sourceIds: string[] }
  | { kind: "nest"; parentId: string }
  | { kind: "unnest" }
  | { kind: "seal"; expectedVersion?: number | null }
  | { kind: "dispatch"; expectedVersion?: number | null; reference?: string | null }
  | { kind: "return"; toLocationId: string; reason: string; expectedVersion?: number | null }
  | { kind: "retire"; reason: string; expectedVersion?: number | null }
  | { kind: "transition"; toStatus: string; expectedVersion?: number | null; reason?: string | null };

const SUCCESS_COPY: Record<LpnAction["kind"], string> = {
  move: "Plate moved — stock relocated",
  load: "Stock loaded onto plate",
  unload: "Stock unloaded to bin",
  split: "Plate split",
  merge: "Plates merged",
  nest: "Plate nested",
  unnest: "Plate detached",
  seal: "Plate sealed",
  dispatch: "Plate dispatched — stock left the warehouse",
  return: "Return received — contents restored for inspection",
  retire: "Plate retired",
  transition: "Plate status updated",
};

function actionToRpc(lpnId: string, a: LpnAction): { name: string; args: Record<string, unknown> } {
  switch (a.kind) {
    case "move":
      return { name: "wms_lpn_move", args: { _lpn_id: lpnId, _to_location_id: a.toLocationId, _expected_version: a.expectedVersion ?? null, _reason: a.reason ?? null } };
    case "load":
      return { name: "wms_lpn_load", args: { _lpn_id: lpnId, _product_id: a.productId, _quantity: a.quantity, _lot_number: a.lotNumber ?? null, _serial_number: a.serialNumber ?? null } };
    case "unload":
      return { name: "wms_lpn_unload", args: { _lpn_id: lpnId, _product_id: a.productId, _quantity: a.quantity, _lot_number: a.lotNumber ?? null } };
    case "split":
      return { name: "wms_lpn_split", args: { _lpn_id: lpnId, _lines: a.lines, _new_lpn_type: a.newType ?? null } };
    case "merge":
      return { name: "wms_lpn_merge", args: { _source_lpn_ids: a.sourceIds, _target_lpn_id: lpnId } };
    case "nest":
      return { name: "wms_lpn_nest", args: { _child_lpn_id: lpnId, _parent_lpn_id: a.parentId } };
    case "unnest":
      return { name: "wms_lpn_unnest", args: { _child_lpn_id: lpnId } };
    case "seal":
      return { name: "wms_lpn_seal", args: { _lpn_id: lpnId, _expected_version: a.expectedVersion ?? null } };
    case "dispatch":
      return { name: "wms_lpn_dispatch", args: { _lpn_id: lpnId, _expected_version: a.expectedVersion ?? null, _reference: a.reference ?? null } };
    case "return":
      return { name: "wms_lpn_receive_return", args: { _lpn_id: lpnId, _to_location_id: a.toLocationId, _reason: a.reason, _expected_version: a.expectedVersion ?? null } };
    case "retire":
      return { name: "wms_lpn_retire", args: { _lpn_id: lpnId, _reason: a.reason, _expected_version: a.expectedVersion ?? null } };
    case "transition":
      return { name: "wms_transition_lpn", args: { _lpn_id: lpnId, _to_status: a.toStatus, _expected_version: a.expectedVersion ?? 0, _reason: a.reason ?? null } };
  }
}

/**
 * Single mutation entry point for every plate operation. One hook keeps
 * the invalidation policy and the error surface identical across actions.
 */
export function useLpnAction(lpnId?: string) {
  const qc = useQueryClient();

  const invalidate = () => {
    for (const key of ["wms-lpns", "wms-lpn", "wms-lpn-contents", "wms-lpn-children", "wms-lpn-events"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const mutation = useMutation({
    mutationFn: async (action: LpnAction) => {
      if (!lpnId) throw new Error("No plate selected");
      const { name, args } = actionToRpc(lpnId, action);
      const { error } = await sb.rpc(name, args);
      if (error) throw error;
      return action.kind;
    },
    onSuccess: (kind) => {
      toast.success(SUCCESS_COPY[kind]);
      invalidate();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Operation rejected"),
  });

  return { run: mutation.mutate, runAsync: mutation.mutateAsync, isPending: mutation.isPending, invalidate };
}
