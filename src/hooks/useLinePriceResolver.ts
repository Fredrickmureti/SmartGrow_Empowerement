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
import { useCallback } from "react";
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
