/**
 * Product BARCODE / GTIN import config (ADR 0074).
 *
 * Populates `product_identifiers` (GTIN-8/12/13/14, ISBN, custom).
 * Must NOT accept master-catalog fields — resolve product by SKU only.
 */
import { FieldDefinition } from "@/lib/importUtils";

export const PRODUCT_BARCODE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["code", "item_code", "product_code", "SKU", "Product Code"] },
  { key: "barcode", label: "Barcode / GTIN", required: true, type: "text", aliases: ["gtin", "ean", "upc", "ean13", "ean_13", "Barcode", "GTIN", "EAN", "UPC"] },
  { key: "identifier_type", label: "Identifier Type", required: false, type: "select", aliases: ["type", "kind"], options: ["gtin8", "gtin12", "gtin13", "gtin14", "isbn", "custom"], allowFallback: true, fallbackValue: "gtin13" },
  { key: "is_primary", label: "Is Primary", required: false, type: "text", aliases: ["primary", "default"] },
  { key: "packaging_qty", label: "Packaging Qty", required: false, type: "number", aliases: ["case size", "pack qty", "units per pack"] },
];
