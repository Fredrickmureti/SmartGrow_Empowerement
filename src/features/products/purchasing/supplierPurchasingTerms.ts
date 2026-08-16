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
 * recomputes purchasing policy — the hook deleted in this phase did exactly
 * that, and read the deprecated product defaults only.

 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type TermsSource = "supplier" | "product_default" | "system_default";

/** Where the resolved price came from. Decided by the server, never inferred. */
export type PurchasePriceSource =
  | "contract"
  | "supplier_tier"
  | "supplier_flat"
  | "product_default"
  | "manual";

export interface PriceBreakTier {
  min_qty: number;
  unit_price: number;
}

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
  /** "tier" when a price break applied, "flat" for the standing price. */
  price_source: "tier" | "flat" | "none";
  tier_min_qty: number | null;
  branch_id: string | null;
}

/** Result of the single purchase-price authority. */
export interface PurchaseLinePrice {
  unit_price?: number | null;
  currency_code?: string | null;
  purchase_uom_id?: string | null;
  price_source: PurchasePriceSource;
  contract_id?: string | null;
  contract_line_id?: string | null;
  supplier_terms_id?: string | null;
  tier_min_qty?: number | null;
  lead_time_days?: number | null;
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
  /** Ordered quantity, in the purchase UoM — drives price-break selection. */
  quantity?: number | null;
  branchId?: string | null;
}): Promise<SupplierPurchasingTerms | null> {
  const { data, error } = await supabase.rpc(
    "resolve_supplier_purchasing_terms" as never,
    {
      p_business_id: args.businessId,
      p_product_id: args.productId,
      p_supplier_id: args.supplierId ?? null,
      p_on_date: args.onDate ?? null,
      p_quantity: args.quantity ?? null,
      p_branch_id: args.branchId ?? null,
    } as never,
  );
  if (error) throw new Error(String(error.message ?? error));
  return firstRow<SupplierPurchasingTerms>(data);
}

/**
 * The one purchasing price authority. Precedence (contract -> supplier tier ->
 * supplier flat -> product default -> manual) is decided server-side; the
 * browser only renders what came back and why.
 */
export async function fetchPurchaseLinePrice(args: {
  businessId: string;
  productId: string;
  supplierId?: string | null;
  quantity?: number | null;
  onDate?: string | null;
  branchId?: string | null;
}): Promise<PurchaseLinePrice | null> {
  const { data, error } = await supabase.rpc(
    "resolve_purchase_line_price" as never,
    {
      p_business_id: args.businessId,
      p_product_id: args.productId,
      p_supplier_id: args.supplierId ?? null,
      p_quantity: args.quantity ?? null,
      p_on_date: args.onDate ?? null,
      p_branch_id: args.branchId ?? null,
    } as never,
  );
  if (error) throw new Error(String(error.message ?? error));
  return (data ?? null) as PurchaseLinePrice | null;
}

/** Operator copy for where a price came from. One place authors it. */
export function describePriceSource(source?: PurchasePriceSource | null): string {
  switch (source) {
    case "contract":
      return "Contract price";
    case "supplier_tier":
      return "Supplier price break";
    case "supplier_flat":
      return "Supplier standing price";
    case "product_default":
      return "Product default cost";
    default:
      return "Entered manually";
  }
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
  quantity?: number | null;
  branchId?: string | null;
}) {
  const { businessId, productId, supplierId, onDate, quantity, branchId } = args;
  return useQuery({
    queryKey: [
      "supplier-purchasing-terms",
      businessId,
      productId,
      supplierId ?? null,
      onDate ?? null,
      quantity ?? null,
      branchId ?? null,
    ],
    enabled: !!businessId && !!productId,
    queryFn: () =>
      fetchSupplierPurchasingTerms({
        businessId: businessId as string,
        productId: productId as string,
        supplierId,
        onDate,
        quantity,
        branchId,
      }),
  });
}

