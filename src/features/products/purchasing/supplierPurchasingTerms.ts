/**
 * Supplier purchasing terms — client read seam (Phase 5B).
 *
 * `supplier_item_terms` is the canonical owner of MOQ, order increment, lead
 * time, currency and purchase UoM. `products.min_order_quantity` /
 * `products.order_quantity_increment` are DEPRECATED product-level defaults and
 * are only consulted by the server resolver as a fallback.
 *
 * All arithmetic (increment rounding, MOQ refusal) lives in
 * `validate_supplier_order_quantity` on the server. The browser never
 * recomputes purchasing policy — the deleted `useMOQValidation` hook used to,
 * and read the product defaults only.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type TermsSource = "supplier" | "product_default" | "system_default";

export interface SupplierPurchasingTerms {
  product_id: string;
  supplier_id: string | null;
  terms_id: string | null;
  min_order_qty: number;
  min_order_source: TermsSource;
  order_increment: number;
  increment_source: TermsSource;
  lead_time_days: number | null;
  lead_time_source: TermsSource;
  currency_code: string | null;
  purchase_uom_id: string | null;
  unit_price: number | null;
  effective_from: string | null;
  effective_to: string | null;
}

export interface OrderQuantityVerdict {
  is_valid: boolean;
  reason:
    | "QUANTITY_NOT_POSITIVE"
    | "BELOW_MIN_ORDER_QTY"
    | "NOT_ON_ORDER_INCREMENT"
    | null;
  min_order_qty: number;
  order_increment: number;
  adjusted_quantity: number;
  min_order_source: TermsSource;
  increment_source: TermsSource;
}

function firstRow<T>(payload: unknown): T | null {
  const row = Array.isArray(payload) ? payload[0] : payload;
  return (row ?? null) as T | null;
}

export async function fetchSupplierPurchasingTerms(args: {
  businessId: string;
  productId: string;
  supplierId?: string | null;
  onDate?: string | null;
}): Promise<SupplierPurchasingTerms | null> {
  const { data, error } = await supabase.rpc(
    "resolve_supplier_purchasing_terms" as never,
    {
      p_business_id: args.businessId,
      p_product_id: args.productId,
      p_supplier_id: args.supplierId ?? null,
      p_on_date: args.onDate ?? null,
    } as never,
  );
  if (error) throw new Error(String(error.message ?? error));
  return firstRow<SupplierPurchasingTerms>(data);
}

export async function validateSupplierOrderQuantity(args: {
  businessId: string;
  productId: string;
  supplierId?: string | null;
  quantity: number;
  onDate?: string | null;
}): Promise<OrderQuantityVerdict | null> {
  const { data, error } = await supabase.rpc(
    "validate_supplier_order_quantity" as never,
    {
      p_business_id: args.businessId,
      p_product_id: args.productId,
      p_supplier_id: args.supplierId ?? null,
      p_quantity: args.quantity,
      p_on_date: args.onDate ?? null,
    } as never,
  );
  if (error) throw new Error(String(error.message ?? error));
  return firstRow<OrderQuantityVerdict>(data);
}

/** Operator copy for a refusal. One place, so no surface authors its own. */
export function describeOrderQuantityVerdict(
  verdict: OrderQuantityVerdict,
  productName?: string | null,
): string | null {
  if (verdict.is_valid) return null;
  const item = productName ? `${productName}` : "This item";
  switch (verdict.reason) {
    case "QUANTITY_NOT_POSITIVE":
      return "Enter a quantity greater than zero.";
    case "BELOW_MIN_ORDER_QTY":
      return `${item} has a minimum order quantity of ${verdict.min_order_qty}.`;
    case "NOT_ON_ORDER_INCREMENT":
      return `${item} must be ordered in multiples of ${verdict.order_increment}. The nearest allowed quantity is ${verdict.adjusted_quantity}.`;
    default:
      return "This quantity is not allowed for the selected supplier.";
  }
}

export function useSupplierPurchasingTerms(args: {
  businessId?: string | null;
  productId?: string | null;
  supplierId?: string | null;
  onDate?: string | null;
}) {
  const { businessId, productId, supplierId, onDate } = args;
  return useQuery({
    queryKey: [
      "supplier-purchasing-terms",
      businessId,
      productId,
      supplierId ?? null,
      onDate ?? null,
    ],
    enabled: !!businessId && !!productId,
    queryFn: () =>
      fetchSupplierPurchasingTerms({
        businessId: businessId as string,
        productId: productId as string,
        supplierId,
        onDate,
      }),
  });
}
