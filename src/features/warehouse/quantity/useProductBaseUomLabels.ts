/**
 * useProductBaseUomLabels — batched productId → base UoM label ("kg", "ea").
 *
 * Warehouse surfaces must not invent unit words. The label is the product's own
 * `base_uom_id` → `units_of_measure.code`, resolved through the canonical
 * `baseUomLabel()` helper in `@/lib/inventory/uom`. One query per surface.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { baseUomLabel } from "@/lib/inventory/uom";

export function useProductBaseUomLabels(
  productIds: ReadonlyArray<string | null | undefined>,
): ReadonlyMap<string, string> {
  const ids = useMemo(
    () => Array.from(new Set(productIds.filter((x): x is string => Boolean(x)))).sort(),
    [productIds],
  );

  const { data } = useQuery({
    queryKey: ["warehouse-base-uom-labels", ids],
    enabled: ids.length > 0,
    staleTime: 300_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("products")
        .select("id, base_uom:units_of_measure!products_base_uom_id_fkey(code, name)")
        .in("id", ids);
      if (error) throw error;
      const out = new Map<string, string>();
      for (const r of (rows ?? []) as Array<{
        id: string;
        base_uom: { code: string | null; name: string | null } | null;
      }>) {
        out.set(r.id, baseUomLabel(r.base_uom));
      }
      return out;
    },
  });

  return data ?? new Map<string, string>();
}
