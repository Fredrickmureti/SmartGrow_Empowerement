/**
 * useSellableUnits — the sell-unit option list for document line editors.
 *
 * A line's `quantity` is ALWAYS base units; `display_quantity` +
 * `display_uom_id` (or `packaging_id`) is what the customer actually bought.
 * The server is authoritative: `public.resolve_line_base_quantity` (called by
 * the `_uom_normalize_line` BEFORE-trigger and by `create_sales_order_atomic`)
 * recomputes the base quantity and rejects cross-dimension conversions. The
 * factors returned here exist ONLY to keep the on-screen line total honest
 * while the operator types.
 *
 * Compatible units are the active UoMs sharing the product's base UoM
 * category; the factor is `factor_to_reference` relative to the base unit.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SellUnitOption {
  id: string;
  code: string;
  name: string;
  /** Base units per one of this unit. */
  factor: number;
}

interface UomRow {
  id: string;
  code: string;
  name: string;
  category_id: string | null;
  factor_to_reference: number | null;
}

export function useSellableUnits() {
  const { data: units = [] } = useQuery<UomRow[]>({
    queryKey: ["units-of-measure-active"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units_of_measure")
        .select("id, code, name, category_id, factor_to_reference")
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as UomRow[];
    },
  });

  const byId = useMemo(() => {
    const m = new Map<string, UomRow>();
    units.forEach((u) => m.set(u.id, u));
    return m;
  }, [units]);

  /** Units the operator may sell a product in, given its base UoM. */
  const unitsForBase = useMemo(
    () =>
      (baseUomId: string | null | undefined): SellUnitOption[] => {
        if (!baseUomId) return [];
        const base = byId.get(baseUomId);
        const baseFactor = Number(base?.factor_to_reference) || 0;
        if (!base || !base.category_id || baseFactor <= 0) return [];
        return units
          .filter(
            (u) =>
              u.category_id === base.category_id &&
              Number(u.factor_to_reference) > 0,
          )
          .map((u) => ({
            id: u.id,
            code: u.code,
            name: u.name,
            factor: Number(u.factor_to_reference) / baseFactor,
          }));
      },
    [byId, units],
  );

  return { unitsForBase, unitById: byId };
}

/**
 * useUnitsForProducts — the `unitsFor` callback every document line editor
 * takes. Pass whichever product list the form already loaded (branch-scoped
 * or plain); rows only need `id` and `base_uom_id`.
 */
export function useUnitsForProducts(
  products: ReadonlyArray<{ id: string; base_uom_id?: string | null }>,
) {
  const { unitsForBase } = useSellableUnits();
  return useMemo(
    () =>
      (productId: string | null | undefined) => {
        if (!productId) return null;
        const p = products.find((x) => x.id === productId);
        if (!p?.base_uom_id) return null;
        return { baseUomId: p.base_uom_id, options: unitsForBase(p.base_uom_id) };
      },
    [products, unitsForBase],
  );
}
