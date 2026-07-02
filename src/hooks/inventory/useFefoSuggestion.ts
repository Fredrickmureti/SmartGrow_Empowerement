/**
 * useFefoSuggestion — fetches the FEFO (first-expiring-first-out) lot
 * allocation for a product+warehouse+qty. Backed by the `resolve_fefo_lots`
 * Postgres RPC shipped in Phase 3a. Returns null while the inputs are
 * incomplete, and an empty array when stock is insufficient (caller renders
 * the appropriate UI). Hard errors surface via React Query's error channel.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface FefoAllocation {
  lot_id: string;
  lot_number: string;
  serial_number: string | null;
  qty: number;
  expiry_date: string | null;
}

interface Params {
  businessId: string | null | undefined;
  warehouseId: string | null | undefined;
  productId: string | null | undefined;
  requiredQty: number;
  enabled?: boolean;
}

export function useFefoSuggestion({
  businessId,
  warehouseId,
  productId,
  requiredQty,
  enabled = true,
}: Params) {
  const ready =
    enabled &&
    Boolean(businessId) &&
    Boolean(warehouseId) &&
    Boolean(productId) &&
    Number.isFinite(requiredQty) &&
    requiredQty > 0;

  return useQuery({
    queryKey: ["fefo", businessId, warehouseId, productId, requiredQty],
    enabled: ready,
    staleTime: 10_000,
    queryFn: async (): Promise<FefoAllocation[]> => {
      const { data, error } = await supabase.rpc("resolve_fefo_lots", {
        p_business_id: businessId!,
        p_warehouse_id: warehouseId!,
        p_product_id: productId!,
        p_required_qty: requiredQty,
      });
      if (error) {
        // insufficient_lot_stock surfaces as a Postgres exception; return
        // an empty allocation so the UI can render a "no lots available"
        // hint instead of a destructive error.
        if (
          typeof error.message === "string" &&
          error.message.toLowerCase().includes("insufficient_lot_stock")
        ) {
          return [];
        }
        throw error;
      }
      return (data ?? []) as FefoAllocation[];
    },
  });
}
