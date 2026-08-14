/**
 * Product master form state (Phase 6 decomposition).
 *
 * The shape of the product payload handed to `saveProductAtomic`, plus the
 * per-jurisdiction fiscal metadata which is deliberately NOT product master
 * data (it lives in `product_tax_localization`).
 *
 * This module is types + initial values only. No business rules: MOQ /
 * increment enforcement is server-owned (ADR 0141), GL resolution is
 * `resolve_product_gl_account`, measures are `resolve_product_measure`.
 */

export interface ProductFormValues {
  name: string;
  description: string;
  type: "product" | "service";
  sku: string;
  unit_price: number;
  cost_price: number;
  tax_rate: number;
  image_url: string | null;
  track_inventory: boolean;
  stock_quantity: number;
  reorder_level: number;
  reorder_quantity: number;
  /** Deprecated fallback default — supplier_item_terms is canonical (ADR 0141). */
  min_order_quantity: number;
  /** Deprecated fallback default — supplier_item_terms is canonical (ADR 0141). */
  order_quantity_increment: number;
  category_id: string | null;
  sales_account_id: string | null;
  purchase_account_id: string | null;
  cogs_account_id: string | null;
  inventory_account_id: string | null;
  tax_rate_id: string | null;
  base_uom_id: string | null;
  sales_uom_id: string | null;
  purchase_uom_id: string | null;
  is_lot_tracked: boolean;
  is_expiry_tracked: boolean;
  expiry_alert_days: number;
}

export interface ProductLocalizationValues {
  classification_code: string;
  unit_code: string;
  packaging_unit: string;
  origin_country: string;
}

/** Patch callback shared by every product form section. */
export type ProductFormPatch = (patch: Partial<ProductFormValues>) => void;

export type ProductLocalizationPatch = (
  patch: Partial<ProductLocalizationValues>,
) => void;

export function createInitialProductFormValues(defaults: {
  defaultLotTracking: boolean;
  defaultExpiryTracking: boolean;
}): ProductFormValues {
  return {
    name: "",
    description: "",
    type: "service",
    sku: "",
    unit_price: 0,
    cost_price: 0,
    tax_rate: 0,
    image_url: null,
    track_inventory: false,
    stock_quantity: 0,
    reorder_level: 0,
    reorder_quantity: 0,
    min_order_quantity: 1,
    order_quantity_increment: 1,
    category_id: null,
    sales_account_id: null,
    purchase_account_id: null,
    cogs_account_id: null,
    inventory_account_id: null,
    tax_rate_id: null,
    base_uom_id: null,
    sales_uom_id: null,
    purchase_uom_id: null,
    is_lot_tracked: defaults.defaultLotTracking,
    is_expiry_tracked: defaults.defaultExpiryTracking,
    expiry_alert_days: 30,
  };
}
