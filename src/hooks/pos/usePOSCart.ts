import { useState, useCallback, useMemo } from "react";
import type { SelectedModifier } from "./useModifiers";

const clampMoney = (value: number, min = 0, max = Number.POSITIVE_INFINITY) =>
  Math.min(Math.max(Number.isFinite(value) ? value : 0, min), max);

export interface CartItemModifier {
  modifier_id: string;
  modifier_name: string;
  price_adjustment: number;
}

export interface CartItem {
  id: string;
  product_id: string | null;
  name: string;
  sku?: string;
  quantity: number;
  unit_price: number;
  discount_type?: "percent" | "fixed";
  discount_value: number;
  discount_percent?: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  cost_price?: number;
  notes?: string;
  // Modifiers (restaurant mode)
  modifiers?: CartItemModifier[];
  modifiers_total?: number;
  // Tax metadata for compliance
  tax_rate_id?: string;
  tax_rate_name?: string;
  etims_tax_code?: string;
  // Category for promotions
  category_id?: string;
  // Packaging / UoM provenance (Phase B UoM unification).
  // `quantity` is ALWAYS the base-unit quantity that hits the ledger.
  // `display_*` carries what the cashier saw on screen — pack qty + label.
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
  base_uom_id?: string | null;
  /** Optional human label for the pack (e.g. "Carton of 12"). UI only. */
  packaging_label?: string;
}

export interface CartCustomer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface CartState {
  items: CartItem[];
  customer: CartCustomer | null;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  notes: string;
}

const generateItemId = () => `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const calculateItemTotals = (
  quantity: number,
  unit_price: number,
  discount_type?: "percent" | "fixed",
  discount_value: number = 0,
  tax_rate: number = 0
) => {
  const gross = quantity * unit_price;
  
  let discountAmount = 0;
  if (discount_type === "percent") {
    discountAmount = gross * (discount_value / 100);
  } else if (discount_type === "fixed") {
    discountAmount = discount_value;
  }
  discountAmount = clampMoney(discountAmount, 0, gross);
  
  const afterDiscount = gross - discountAmount;
  const taxAmount = afterDiscount * (tax_rate / 100);
  const lineTotal = afterDiscount + taxAmount;

  return {
    discount_amount: discountAmount,
    tax_amount: taxAmount,
    line_total: lineTotal,
  };
};

export function usePOSCart() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [notes, setNotes] = useState("");
  const [cartDiscount, setCartDiscount] = useState<{ type: "percent" | "fixed"; value: number } | null>(null);

  // Add item to cart
  const addItem = useCallback((product: {
    id: string;
    name: string;
    sku?: string;
    price: number;
    tax_rate?: number;
    cost_price?: number;
    // Tax metadata for compliance
    tax_rate_id?: string;
    tax_rate_name?: string;
    etims_tax_code?: string;
    // Category for promotions
    category_id?: string;
    // Modifiers (restaurant mode)
    modifiers?: CartItemModifier[];
    modifiers_total?: number;
    // Packaging / UoM provenance (Phase B). `quantity` here is base units.
    packaging_id?: string | null;
    display_uom_id?: string | null;
    display_quantity?: number | null;
    base_uom_id?: string | null;
    packaging_label?: string;
  }, quantity: number = 1) => {
    setItems((prev) => {
      const hasModifiers = product.modifiers && product.modifiers.length > 0;
      const effectivePrice = product.price + (product.modifiers_total || 0);
      
      // If product has modifiers, always add as a new line (customizations differ)
      // Otherwise, check if product already exists in cart and increment quantity
      // Lines carrying a packaging_id are kept distinct so pack provenance is preserved.
      if (!hasModifiers && !product.packaging_id) {
        const existingIndex = prev.findIndex((item) =>
          item.product_id === product.id &&
          (!item.modifiers || item.modifiers.length === 0) &&
          !item.packaging_id
        );
        
        if (existingIndex >= 0) {
          const updated = [...prev];
          const existing = updated[existingIndex];
          const newQuantity = existing.quantity + quantity;
          const totals = calculateItemTotals(
            newQuantity,
            existing.unit_price,
            existing.discount_type,
            existing.discount_value,
            existing.tax_rate
          );
          
          updated[existingIndex] = {
            ...existing,
            quantity: newQuantity,
            tax_amount: totals.tax_amount,
            line_total: totals.line_total,
          };
          return updated;
        }
      }

      // Add new item
      const totals = calculateItemTotals(
        quantity,
        effectivePrice,
        undefined,
        0,
        product.tax_rate || 0
      );

      // Build modifier name suffix
      const modifierSuffix = product.modifiers?.length 
        ? ` (${product.modifiers.map(m => m.modifier_name).join(', ')})` 
        : '';

      const newItem: CartItem = {
        id: generateItemId(),
        product_id: product.id,
        name: product.name + modifierSuffix,
        sku: product.sku,
        quantity,
        unit_price: effectivePrice,
        discount_type: undefined,
        discount_value: 0,
        tax_rate: product.tax_rate || 0,
        tax_amount: totals.tax_amount,
        line_total: totals.line_total,
        cost_price: product.cost_price,
        modifiers: product.modifiers,
        modifiers_total: product.modifiers_total || 0,
        category_id: product.category_id,
        // Tax metadata for compliance - snapshot at time of sale
        tax_rate_id: product.tax_rate_id,
        tax_rate_name: product.tax_rate_name,
        etims_tax_code: product.etims_tax_code,
        // Packaging / UoM provenance
        packaging_id: product.packaging_id ?? null,
        display_uom_id: product.display_uom_id ?? null,
        display_quantity: product.display_quantity ?? null,
        base_uom_id: product.base_uom_id ?? null,
        packaging_label: product.packaging_label,
      };

      return [...prev, newItem];
    });
  }, []);

  // Update item quantity
  const updateQuantity = useCallback((itemId: string, quantity: number) => {
    if (quantity <= 0) {
      setItems((prev) => prev.filter((item) => item.id !== itemId));
      return;
    }

    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        
        const totals = calculateItemTotals(
          quantity,
          item.unit_price,
          item.discount_type,
          item.discount_value,
          item.tax_rate
        );

        return {
          ...item,
          quantity,
          tax_amount: totals.tax_amount,
          line_total: totals.line_total,
        };
      })
    );
  }, []);

  // Apply discount to item
  const applyItemDiscount = useCallback((
    itemId: string,
    discount_type: "percent" | "fixed",
    discount_value: number
  ) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;

        const totals = calculateItemTotals(
          item.quantity,
          item.unit_price,
          discount_type,
          discount_value,
          item.tax_rate
        );

        return {
          ...item,
          discount_type,
          discount_value,
          tax_amount: totals.tax_amount,
          line_total: totals.line_total,
        };
      })
    );
  }, []);

  // Remove item from cart
  const removeItem = useCallback((itemId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== itemId));
  }, []);

  // Clear cart
  const clearCart = useCallback(() => {
    setItems([]);
    setCustomer(null);
    setNotes("");
    setCartDiscount(null);
  }, []);

  // Calculate totals
  // Calculate totals with tax computed AFTER cart-level discount (tax compliance)
  const totals = useMemo(() => {
    // Step 1: Calculate subtotal (sum of line totals after item-level discounts, before tax)
    const subtotal = items.reduce((sum, item) => {
      const itemGross = item.quantity * item.unit_price;
      let itemDiscount = 0;
      if (item.discount_type === "percent") {
        itemDiscount = itemGross * (item.discount_value / 100);
      } else if (item.discount_type === "fixed") {
        itemDiscount = item.discount_value;
      }
      itemDiscount = clampMoney(itemDiscount, 0, itemGross);
      return sum + (itemGross - itemDiscount);
    }, 0);

    // Step 2: Calculate cart-level discount
    let discountAmount = 0;
    if (cartDiscount) {
      if (cartDiscount.type === "percent") {
        discountAmount = subtotal * (cartDiscount.value / 100);
      } else {
        discountAmount = cartDiscount.value;
      }
    }
    discountAmount = clampMoney(discountAmount, 0, subtotal);

    // Step 3: Recalculate tax on post-discount amounts
    // Proportionally distribute cart discount across items, then compute tax
    let taxAmount = 0;
    if (subtotal > 0 && discountAmount > 0) {
      taxAmount = items.reduce((sum, item) => {
        const itemGross = item.quantity * item.unit_price;
        let itemDiscount = 0;
        if (item.discount_type === "percent") {
          itemDiscount = itemGross * (item.discount_value / 100);
        } else if (item.discount_type === "fixed") {
          itemDiscount = item.discount_value;
        }
        itemDiscount = clampMoney(itemDiscount, 0, itemGross);
        const itemNet = itemGross - itemDiscount;
        // Proportional share of cart discount for this item
        const itemCartDiscount = (itemNet / subtotal) * discountAmount;
        const itemAfterAllDiscounts = itemNet - itemCartDiscount;
        return sum + itemAfterAllDiscounts * (item.tax_rate / 100);
      }, 0);
    } else {
      // No cart discount — use pre-calculated per-item tax
      taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
    }

    const afterCartDiscount = subtotal - discountAmount;
    const total = afterCartDiscount + taxAmount;

    return {
      subtotal,
      discount_amount: discountAmount,
      tax_amount: taxAmount,
      total,
    };
  }, [items, cartDiscount]);

  // Get cart state for saving
  const cartState: CartState = useMemo(() => ({
    items,
    customer,
    subtotal: totals.subtotal,
    discount_amount: totals.discount_amount,
    tax_amount: totals.tax_amount,
    total: totals.total,
    notes,
  }), [items, customer, totals, notes]);

  // Restore cart from saved state
  const restoreCart = useCallback((state: CartState) => {
    setItems(state.items);
    setCustomer(state.customer);
    setNotes(state.notes);
  }, []);

  return {
    items,
    customer,
    notes,
    /** Cart-level discount input — priced by the server, not by the till. */
    cartDiscount,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    ...totals,
    cartState,
    addItem,
    updateQuantity,
    applyItemDiscount,
    removeItem,
    clearCart,
    setCustomer,
    setNotes,
    setCartDiscount,
    restoreCart,
  };
}
