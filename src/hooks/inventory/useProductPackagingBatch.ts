/**
 * useProductPackagingBatch — single batched fetch of `product_packaging`
 * rows for a set of product ids. Used by listings (Products, Inventory) to
 * render pack rollups inside `StockCell` and to decide whether to show the
 * "Multi-UoM" badge from `useProductBadges` — without firing one query per
 * row.
 *
 * Returns:
 *   packsByProduct: Map<productId, PackForRollup[]>
 *   hasPackagingSet: Set<productId> (cheap presence check for the badge)
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { PackForRollup } from "@/lib/inventory/formatQty";

export interface ProductPackagingBatch {
  packsByProduct: Map<string, PackForRollup[]>;
  hasPackagingSet: Set<string>;
  isLoading: boolean;
}

export function useProductPackagingBatch(
  productIds: ReadonlyArray<string>,
): ProductPackagingBatch {
  const uniqueIds = useMemo(
    () => Array.from(new Set(productIds.filter(Boolean))).sort(),
    [productIds],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["product-packaging-batch-listing", uniqueIds],
    enabled: uniqueIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("product_packaging")
        .select("id, product_id, name, qty_in_base_uom")
        .in("product_id", uniqueIds);
      if (error) throw error;
      const byProduct = new Map<string, PackForRollup[]>();
      for (const r of rows ?? []) {
        const list = byProduct.get(r.product_id) ?? [];
        list.push({ id: r.id, name: r.name, qty_in_base_uom: Number(r.qty_in_base_uom) });
        byProduct.set(r.product_id, list);
      }

      return byProduct;
    },
  });

  const packsByProduct = data ?? new Map<string, PackForRollup[]>();
  const hasPackagingSet = useMemo(
    () => new Set(packsByProduct.keys()),
    [packsByProduct],
  );

  return { packsByProduct, hasPackagingSet, isLoading };
}