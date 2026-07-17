/**
 * Product PRICE-LIST import config (ADR 0074).
 *
 * Populates `price_list_items` under a named `price_lists` row.
 */
import { FieldDefinition } from "@/lib/importUtils";

export const PRODUCT_PRICE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "price_list", label: "Price List Name", required: true, type: "text", aliases: ["list", "tier", "price_book"] },
  { key: "price", label: "Price", required: true, type: "number", aliases: ["unit_price", "sale_price"] },
  { key: "currency", label: "Currency", required: false, type: "text", aliases: ["ccy", "currency_code"] },
  { key: "min_quantity", label: "Min Quantity", required: false, type: "number", aliases: ["min_qty", "tier_from"] },
  { key: "valid_from", label: "Valid From", required: false, type: "date", aliases: ["start", "effective_from"] },
  { key: "valid_to", label: "Valid To", required: false, type: "date", aliases: ["end", "effective_to"] },
];
