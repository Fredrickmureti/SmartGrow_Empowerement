/**
 * Product SUPPLIER PRICELIST import config (ADR 0074).
 *
 * Populates `vendor_pricelists` (vendor cost tiers, lead time).
 */
import { FieldDefinition } from "@/lib/importUtils";

export const PRODUCT_SUPPLIER_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "vendor", label: "Vendor / Supplier", required: true, type: "text", aliases: ["supplier", "vendor_name", "vendor_code"] },
  { key: "vendor_product_code", label: "Vendor Product Code", required: false, type: "text", aliases: ["supplier_sku", "vendor_sku"] },
  { key: "cost_price", label: "Cost Price", required: true, type: "number", aliases: ["cost", "purchase_price"] },
  { key: "currency", label: "Currency", required: false, type: "text", aliases: ["ccy"] },
  { key: "min_order_qty", label: "Minimum Order Qty", required: false, type: "number", aliases: ["moq", "min_order"] },
  { key: "lead_time_days", label: "Lead Time (days)", required: false, type: "number", aliases: ["lead_time", "days"] },
  { key: "is_preferred", label: "Preferred Vendor", required: false, type: "text", aliases: ["preferred", "primary"] },
];
