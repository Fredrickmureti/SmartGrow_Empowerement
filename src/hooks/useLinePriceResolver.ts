/**
 * Server-authoritative line pricing (Phase 4).
 *
 * `public.resolve_line_unit_price` is the ONLY place that decides what a unit
 * costs: customer price list > business price book > product scalar, scaled by
 * the same base-unit factor the quantity contract uses. The database stamps
 * that price on write (`_pricing_normalize_line`); this hook exists so the
 * editor SHOWS the same number before saving instead of guessing from
 * `products.unit_price`.
 *
 * A price the user types is never overwritten — it is recorded as `manual`.
 */
import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface LinePriceRequest {
  productId: string | null | undefined;
  packagingId?: string | null;
  displayUomId?: string | null;
  displayQuantity?: number | null;
}

export interface ResolvedLinePrice {
  unit_price: number;
  source: "price_list" | "price_book" | "product" | "manual";
  price_list_id: string | null;
  discount_percent: number;
  factor: number;
}

export function useLinePriceResolver(
  businessId: string | null | undefined,
  contactId: string | null | undefined,
) {
  return useCallback(
    async (req: LinePriceRequest): Promise<ResolvedLinePrice | null> => {
      if (!req.productId || !businessId) return null;
      const { data, error } = await supabase.rpc("resolve_line_unit_price", {
        p_business_id: businessId,
        p_product_id: req.productId,
        p_contact_id: contactId ?? null,
        p_packaging_id: req.packagingId ?? null,
        p_display_uom_id: req.displayUomId ?? null,
        p_display_quantity: req.displayQuantity ?? 1,
      });
      if (error) {
        // Non-fatal: the server still prices the row on insert.
        console.warn("resolve_line_unit_price failed", error.message);
        return null;
      }
      return (data as unknown as ResolvedLinePrice) ?? null;
    },
    [businessId, contactId],
  );
}

/**
 * Applies the server-resolved price to a line in a `useState` line array.
 * Call it whenever the product, packaging or selling unit changes — the price
 * of "one unit" only means something once those are known.
 */
export function useServerPriceApplier<
  T extends {
    product_id?: string | null;
    packaging_id?: string | null;
    display_uom_id?: string | null;
    display_quantity?: number | null;
    quantity?: number | null;
    unit_price?: number;
  },
>(
  lines: T[],
  setLines: Dispatch<SetStateAction<T[]>>,
  resolvePrice: ReturnType<typeof useLinePriceResolver>,
) {
  const linesRef = useRef(lines);
  linesRef.current = lines;

  return useCallback(
    async (index: number, patch: Partial<T>) => {
      const row = { ...(linesRef.current[index] ?? ({} as T)), ...patch } as T;
      if (!row.product_id) return;
      const res = await resolvePrice({
        productId: row.product_id,
        packagingId: row.packaging_id ?? null,
        displayUomId: row.display_uom_id ?? null,
        displayQuantity: row.display_quantity ?? row.quantity ?? 1,
      });
      if (!res) return;
      setLines((prev) =>
        prev.map((it, i) => {
          if (i !== index) return it;
          const nextLine: Record<string, unknown> = { ...it, unit_price: res.unit_price };
          if ("discount_percent" in it && res.discount_percent > 0 && !Number((it as Record<string, unknown>).discount_percent)) {
            nextLine.discount_percent = res.discount_percent;
          }
          return nextLine as T;
        }),
      );
    },
    [resolvePrice, setLines],
  );
}
