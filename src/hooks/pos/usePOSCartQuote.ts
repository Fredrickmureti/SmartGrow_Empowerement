/**
 * usePOSCartQuote — POS Wave Phase 4 (pricing & tax authority).
 *
 * The till NEVER decides what a basket costs. Every sellable price, every
 * discount and every tax figure shown at the terminal is produced by the
 * server RPC `pos_quote_cart`, which is the same resolver stack
 * (`pos_resolve_line` → `resolve_line_unit_price` / `resolve_sales_line_tax`)
 * that `process_pos_transaction` uses when the sale is committed. Price
 * lists, customer-group pricing, pack/UoM pricing, tax-inclusive rates and
 * customer exemptions therefore resolve identically in the preview and in
 * the ledger.
 *
 * FAIL CLOSED: if the pricing authority is unreachable or the quote does not
 * describe the current basket, `status` is not "ready" and the terminal must
 * refuse to tender. A stale or locally computed total is never treated as
 * authoritative.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface QuoteLineInput {
  line_id: string;
  product_id: string | null;
  quantity: number;
  unit_price: number;
  discount_type?: string | null;
  discount_value?: number | null;
  packaging_id?: string | null;
  display_uom_id?: string | null;
}

export interface QuotedLine {
  line_id: string | null;
  product_id: string | null;
  quantity: number;
  unit_price: number;
  catalog_price: number;
  price_source: string;
  price_list_id: string | null;
  group_discount_percent: number;
  tax_rate: number;
  tax_rate_id: string | null;
  tax_inclusive: boolean;
  tax_source: string;
  discount_amount: number;
  taxable: number;
  tax_amount: number;
  line_total: number;
}

export interface CartQuote {
  business_id: string;
  branch_id: string | null;
  quoted_at: string;
  lines: QuotedLine[];
  subtotal: number;
  line_discount_amount: number;
  cart_discount_amount: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
}

export type PricingAuthorityStatus = "empty" | "pending" | "ready" | "unavailable";

interface Options {
  registerId?: string | null;
  lines: QuoteLineInput[];
  customerId?: string | null;
  cartDiscount?: { type: "percent" | "fixed"; value: number } | null;
  enabled?: boolean;
}

/** Stable identity of the priced basket — the quote is only authoritative for it. */
export function cartQuoteSignature(
  lines: QuoteLineInput[],
  customerId: string | null | undefined,
  cartDiscount: { type: string; value: number } | null | undefined,
): string {
  return JSON.stringify({
    c: customerId ?? null,
    d: cartDiscount ? [cartDiscount.type, cartDiscount.value] : null,
    l: lines.map((l) => [
      l.product_id ?? null,
      l.quantity,
      l.product_id ? null : l.unit_price, // catalog lines are priced server-side
      l.discount_type ?? null,
      l.discount_value ?? 0,
      l.packaging_id ?? null,
      l.display_uom_id ?? null,
    ]),
  });
}

export function usePOSCartQuote({
  registerId,
  lines,
  customerId,
  cartDiscount,
  enabled = true,
}: Options) {
  const signature = useMemo(
    () => cartQuoteSignature(lines, customerId, cartDiscount),
    [lines, customerId, cartDiscount],
  );

  const isEmpty = lines.length === 0;
  const canQuote = Boolean(enabled && registerId) && !isEmpty;

  const query = useQuery({
    queryKey: ["pos-cart-quote", registerId, signature],
    enabled: canQuote,
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<CartQuote> => {
      const { data, error } = await supabase.rpc("pos_quote_cart" as never, {
        p_register_id: registerId,
        p_lines: lines.map((l) => ({
          line_id: l.line_id,
          product_id: l.product_id,
          quantity: l.quantity,
          unit_price: l.unit_price,
          discount_type: l.discount_type ?? null,
          discount_value: l.discount_value ?? 0,
          packaging_id: l.packaging_id ?? null,
          display_uom_id: l.display_uom_id ?? null,
        })),
        p_contact_id: customerId ?? null,
        p_cart_discount_type: cartDiscount?.type ?? null,
        p_cart_discount_value: cartDiscount?.value ?? 0,
      } as never);
      if (error) throw error;
      return data as unknown as CartQuote;
    },
  });

  const quote = query.data ?? null;

  const status: PricingAuthorityStatus = isEmpty
    ? "empty"
    : !canQuote || query.isError
      ? "unavailable"
      : quote && !query.isFetching
        ? "ready"
        : "pending";

  const linesById = useMemo(() => {
    const map = new Map<string, QuotedLine>();
    for (const l of quote?.lines ?? []) {
      if (l.line_id) map.set(l.line_id, l);
    }
    return map;
  }, [quote]);

  return {
    quote,
    quotedLineById: linesById,
    /** Only "ready" may tender — anything else must block the sale. */
    status,
    isPricingAuthoritative: status === "ready",
    isQuoting: query.isFetching,
    error: query.error as Error | null,
    refetchQuote: query.refetch,
    signature,
  };
}
