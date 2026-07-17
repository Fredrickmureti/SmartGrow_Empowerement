/**
 * Product WAREHOUSE STOCK / opening-balance import config (ADR 0074).
 *
 * Creates initial `stock_quants` (post-Phase-5) rows via a controlled
 * opening-balance adjustment. Does NOT modify master fields.
 */
import { FieldDefinition } from "@/lib/importUtils";

export const PRODUCT_WAREHOUSE_STOCK_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "warehouse", label: "Warehouse", required: true, type: "text", aliases: ["location", "warehouse_code", "site"] },
  { key: "lot_number", label: "Lot / Batch Number", required: false, type: "text", aliases: ["batch", "lot"] },
  { key: "quantity", label: "On-Hand Quantity", required: true, type: "number", aliases: ["qty", "stock", "on_hand", "Opening Stock", "Quantity on Hand"] },
  { key: "reorder_level", label: "Reorder Level", required: false, type: "number", aliases: ["min stock", "Reorder Level", "Reorder Point"] },
  { key: "reorder_quantity", label: "Reorder Quantity", required: false, type: "number", aliases: ["reorder qty", "Order Quantity"] },
];
