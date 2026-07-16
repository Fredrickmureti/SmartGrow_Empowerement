/**
 * useProductTrackingFlags — batched read of tracking flags for a set of
 * product ids so line editors can render lot / serial pickers without a
 * per-row query.
 *
 * Phase A.3 (ADR 0066/0067): the DB rejects outbound movements missing
 * lot / serial linkage for tracked products. UI needs these flags at
 * render time so the operator sees a picker BEFORE post rather than a
 * raw error at post time.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ProductTrackingFlags {
  is_lot_tracked: boolean;
  is_expiry_tracked: boolean;
  is_serial_tracked: boolean;
}

const EMPTY_FLAGS: ProductTrackingFlags = {
  is_lot_tracked: false,
  is_expiry_tracked: false,
  is_serial_tracked: false,
};

export function useProductTrackingFlags(
  productIds: (string | null | undefined)[],
) {
  const cleaned = Array.from(
    new Set(productIds.filter((v): v is string => !!v)),
  ).sort();
  const enabled = cleaned.length > 0;

  const query = useQuery({
    queryKey: ["product-tracking-flags", cleaned],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, ProductTrackingFlags>> => {
      const { data, error } = await supabase
        .from("products")
        .select("id, is_lot_tracked, is_expiry_tracked, is_serial_tracked")
        .in("id", cleaned);
      if (error) throw error;
      const map: Record<string, ProductTrackingFlags> = {};
      for (const row of (data ?? []) as any[]) {
        map[row.id] = {
          is_lot_tracked: !!row.is_lot_tracked,
          is_expiry_tracked: !!row.is_expiry_tracked,
          is_serial_tracked: !!row.is_serial_tracked,
        };
      }
      return map;
    },
  });

  const get = (productId: string | null | undefined): ProductTrackingFlags => {
    if (!productId) return EMPTY_FLAGS;
    return query.data?.[productId] ?? EMPTY_FLAGS;
  };

  return { get, isLoading: query.isLoading, data: query.data ?? {} };
}
