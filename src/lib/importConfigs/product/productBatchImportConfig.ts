/**
 * Product BATCH / LOT import config (ADR 0074).
 *
 * Populates `stock_lots` (lot_number, mfg/expiry). Requires SKU or barcode
 * to resolve the product; warehouse/quantity live in the warehouse-stock config.
 */
import { FieldDefinition } from "@/lib/importUtils";

export const PRODUCT_BATCH_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: false, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "barcode", label: "Barcode / GTIN", required: false, type: "text", aliases: ["gtin", "ean", "upc"] },
  { key: "lot_number", label: "Lot / Batch Number", required: true, type: "text", aliases: ["batch", "batch_no", "lot", "Lot No"] },
  { key: "manufacture_date", label: "Manufacture Date", required: false, type: "date", aliases: ["mfg_date", "mfg", "produced_on"] },
  { key: "expiry_date", label: "Expiry Date", required: false, type: "date", aliases: ["expiry", "expires", "best_before", "Expiry"] },
  { key: "supplier_lot_number", label: "Supplier Lot Number", required: false, type: "text", aliases: ["vendor_lot", "supplier_batch"] },
];
