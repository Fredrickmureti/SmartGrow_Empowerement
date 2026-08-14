/**
 * Product tax localization — client read seam.
 *
 * Per-jurisdiction fiscal metadata (KRA eTIMS today) lives in
 * `product_tax_localization`, never on the product master. The `etims_*`
 * columns were dropped from `products`, so any client still reading
 * `product.etims_classification_code` silently reads `undefined`.
 *
 * Writes go through `save_product_atomic`'s `localization` payload — this
 * module only reads, so there is exactly one write path.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ProductTaxLocalization {
  jurisdiction: string;
  classification_code: string | null;
  item_code: string | null;
  unit_code: string | null;
  packaging_unit: string | null;
  origin_country: string | null;
  registration_status: string | null;
  registered_at: string | null;
}

export async function fetchProductTaxLocalization(
  productId: string,
  jurisdiction?: string | null,
): Promise<ProductTaxLocalization | null> {
  const { data, error } = await supabase.rpc(
    "resolve_product_tax_localization" as never,
    { p_product_id: productId, p_jurisdiction: jurisdiction ?? null } as never,
  );
  if (error) throw new Error(String(error.message ?? error));
  const row = (Array.isArray(data) ? data[0] : data) as ProductTaxLocalization | null;
  return row ?? null;
}

export function useProductTaxLocalization(
  productId?: string | null,
  jurisdiction?: string | null,
) {
  return useQuery({
    queryKey: ["product-tax-localization", productId, jurisdiction ?? null],
    enabled: !!productId,
    queryFn: () => fetchProductTaxLocalization(productId as string, jurisdiction),
  });
}
