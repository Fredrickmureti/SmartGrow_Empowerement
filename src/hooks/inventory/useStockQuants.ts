/**
 * useStockQuants — canonical read hook for the new location-aware
 * inventory ledger (ADR-0064).
 *
 * Prefer this hook for NEW features that need to answer "how much of
 * product X is at location Y". Existing consumers of `warehouse_stock`
 * are not migrated yet — they continue to work unchanged during the
 * additive rollout.
 *
 * Two views back this hook:
 *   - v_stock_on_hand           — one row per (product, location, lot)
 *   - v_warehouse_stock_effective — aggregated back to warehouse level,
 *                                    matching the shape of warehouse_stock
 *   - v_location_summary        — per-location totals for pickers
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface StockOnHandRow {
  quant_id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  product_id: string;
  location_id: string;
  warehouse_id: string;
  location_code: string;
  location_name: string;
  location_type: string;
  location_usage: string;
  lot_number: string | null;
  package_id: string | null;
  owner_id: string | null;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  updated_at: string;
}

export interface LocationSummary {
  location_id: string;
  warehouse_id: string;
  business_id: string;
  branch_id: string | null;
  code: string;
  name: string;
  location_type: string;
  usage: string;
  is_active: boolean;
  is_default: boolean;
  distinct_skus: number;
  total_quantity: number;
  total_reserved: number;
  last_movement_at: string | null;
}

interface UseStockQuantsOptions {
  productId?: string;
  locationId?: string;
  warehouseId?: string;
  lotNumber?: string;
  enabled?: boolean;
}

/**
 * Per (product, location, lot) on-hand rows.
 */
export function useStockQuants(opts: UseStockQuantsOptions = {}) {
  const { currentOrg } = useOrganization();
  const { productId, locationId, warehouseId, lotNumber, enabled = true } = opts;

  return useQuery({
    queryKey: [
      "stock-quants",
      currentOrg?.id,
      { productId, locationId, warehouseId, lotNumber },
    ],
    enabled: enabled && Boolean(currentOrg?.id),
    queryFn: async (): Promise<StockOnHandRow[]> => {
      let q = supabase
        .from("v_stock_on_hand" as never)
        .select("*")
        .eq("organization_id", currentOrg!.id);

      if (productId) q = q.eq("product_id", productId);
      if (locationId) q = q.eq("location_id", locationId);
      if (warehouseId) q = q.eq("warehouse_id", warehouseId);
      if (lotNumber) q = q.eq("lot_number", lotNumber);

      const { data, error } = await q.order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as StockOnHandRow[];
    },
    staleTime: 15_000,
  });
}

/**
 * Per-location totals — dashboards, location pickers, cycle-count
 * scheduling.
 */
export function useLocationSummary(warehouseId?: string) {
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["location-summary", currentBusiness?.id, warehouseId],
    enabled: Boolean(currentBusiness?.id),
    queryFn: async (): Promise<LocationSummary[]> => {
      let q = supabase
        .from("v_location_summary" as never)
        .select("*")
        .eq("business_id", currentBusiness!.id);
      if (warehouseId) q = q.eq("warehouse_id", warehouseId);
      const { data, error } = await q.order("is_default", { ascending: false }).order("code");
      if (error) throw error;
      return (data ?? []) as unknown as LocationSummary[];
    },
    staleTime: 30_000,
  });
}

/**
 * Ops helper — four-way drift check (ADR 0142 Phase 3). Compares the quant
 * ledger against every derived projection: warehouse_stock, the per-lot
 * balance, and the product-level cache. Empty result = clean.
 */
export type StockQuantDriftRow = {
  scope: "warehouse_stock" | "warehouse_stock_lots" | "products.stock_quantity";
  warehouse_id: string | null;
  product_id: string;
  lot_number: string | null;
  quant_qty: number;
  projected_qty: number;
  drift: number;
};

export function useStockQuantDrift(businessId?: string) {
  return useQuery({
    queryKey: ["stock-quant-drift", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("check_stock_quant_drift", {
        _business_id: businessId ?? null,
      });
      if (error) throw error;
      return (data ?? []) as StockQuantDriftRow[];
    },
    staleTime: 60_000,
  });
}

/**
 * Ops helper — reversal parity (ADR 0142 Phase 3 item 1). Reports any
 * database routine that writes stock movements without a registered,
 * existing reversal path. Empty result = every write can be undone.
 */
export type ReversalCoverageRow = {
  issue: "unregistered_writer" | "stale_registration" | "missing_reversal";
  function_name: string;
  detail: string;
};

export function useMovementReversalCoverage(enabled = true) {
  return useQuery({
    queryKey: ["movement-reversal-coverage"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("check_movement_reversal_coverage");
      if (error) throw error;
      return (data ?? []) as ReversalCoverageRow[];
    },
    staleTime: 300_000,
  });
}


