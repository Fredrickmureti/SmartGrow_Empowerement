/**
 * usePOSCartAdapter - Unified cart interface for retail and restaurant modes
 *
 * In retail mode (no tableSessionId): uses in-memory usePOSCart
 * In restaurant mode (tableSessionId present): uses persistent useTableOrder
 *
 * Both provide the same CartItem-based interface so the terminal doesn't care.
 *
 * POS Wave Phase 4 — pricing & tax authority: whichever cart is active, the
 * money the cashier sees comes from the SERVER quote (`pos_quote_cart`), not
 * from the local line math. The local figures remain only as an optimistic
 * placeholder while the quote is in flight; `pricingStatus` tells the terminal
 * whether the basket may be tendered (fail closed when it is not "ready").
 */

import { useMemo } from "react";
import { usePOSCart } from "./usePOSCart";
import { useTableOrder } from "./useTableOrder";
import { usePOSCartQuote, type QuoteLineInput } from "./usePOSCartQuote";

interface AdapterOptions {
  tableSessionId: string | null;
  registerId: string;
  shiftId: string;
  tableNumber?: string;
}

export function usePOSCartAdapter({ tableSessionId, registerId, shiftId, tableNumber }: AdapterOptions) {
  // Always call both hooks (React rules), but only use one
  const retailCart = usePOSCart();
  const tableOrder = useTableOrder({
    tableSessionId: tableSessionId || "__none__",
    registerId,
    shiftId,
    tableNumber,
  });

  const isRestaurantMode = !!tableSessionId;
  const base = isRestaurantMode ? tableOrder : retailCart;

  const quoteLines = useMemo<QuoteLineInput[]>(
    () =>
      (base.items ?? []).map((item) => ({
        line_id: item.id,
        product_id: item.product_id ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_type: item.discount_type ?? null,
        discount_value: item.discount_value ?? 0,
        packaging_id: item.packaging_id ?? null,
        display_uom_id: item.display_uom_id ?? null,
      })),
    [base.items],
  );

  const {
    quote,
    quotedLineById,
    status: pricingStatus,
    isPricingAuthoritative,
    isQuoting,
    error: pricingError,
    refetchQuote,
  } = usePOSCartQuote({
    registerId,
    lines: quoteLines,
    customerId: base.customer?.id ?? null,
    cartDiscount: isRestaurantMode ? null : retailCart.cartDiscount,
  });

  // Server-priced lines for display. Falls back to the local optimistic line
  // only while the quote is pending — never for a tender decision.
  const items = useMemo(
    () =>
      (base.items ?? []).map((item) => {
        const q = quotedLineById.get(item.id);
        if (!q) return item;
        return {
          ...item,
          unit_price: q.unit_price,
          tax_rate: q.tax_rate,
          tax_rate_id: q.tax_rate_id ?? item.tax_rate_id,
          tax_amount: q.tax_amount,
          line_total: q.line_total,
        };
      }),
    [base.items, quotedLineById],
  );

  const totals = quote
    ? {
        subtotal: quote.subtotal,
        discount_amount: quote.discount_amount,
        tax_amount: quote.tax_amount,
        total: quote.total,
      }
    : {
        subtotal: base.subtotal,
        discount_amount: base.discount_amount,
        tax_amount: base.tax_amount,
        total: base.total,
      };

  const pricing = {
    quote,
    quotedLineById,
    pricingStatus,
    isPricingAuthoritative,
    isQuoting,
    pricingError,
    refetchQuote,
  };

  if (isRestaurantMode) {
    return {
      ...tableOrder,
      ...pricing,
      items,
      ...totals,
      cartState: { ...tableOrder.cartState, items, ...totals },
      // Restaurant bills carry no cart-level discount today; the key is present
      // so consumers (e.g. the Phase 7 commit envelope) can read it off either
      // branch of the union without narrowing.
      cartDiscount: null as { type: "percent" | "fixed"; value: number } | null,
      isRestaurantMode: true as const,
      transactionId: tableOrder.transactionId,
      draftTransactionNumber: tableOrder.draftTransactionNumber,
      isOrderLoading: tableOrder.isLoading,
    };
  }

  return {
    ...retailCart,
    ...pricing,
    items,
    ...totals,
    cartState: { ...retailCart.cartState, items, ...totals },
    isRestaurantMode: false as const,
    transactionId: undefined as string | undefined,
    draftTransactionNumber: undefined as string | undefined,
    isOrderLoading: false,
  };
}
