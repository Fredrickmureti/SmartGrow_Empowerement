/**
 * @deprecated ADR 0074 — Product imports are split by concern.
 *
 * This module remains as a thin compatibility shim over the split configs in
 * `./product/*ImportConfig.ts`. New callers MUST import from the split files
 * directly. The `product-imports-are-split` architecture guard enforces this.
 */
import { FieldDefinition } from "@/lib/importUtils";
import {
  PRODUCT_MASTER_IMPORT_FIELDS,
  createProductMasterMigrationHandler,
  createProductMasterBatchMigrationHandler,
  normalizeProductType,
} from "./product/productMasterImportConfig";
import { PRODUCT_WAREHOUSE_STOCK_IMPORT_FIELDS } from "./product/productWarehouseStockImportConfig";
import { PRODUCT_BARCODE_IMPORT_FIELDS } from "./product/productBarcodeImportConfig";

// Legacy union — existing single-file importers (Products page + Migration step)
// keep working. New importers should target the split configs.
export const PRODUCT_IMPORT_FIELDS: FieldDefinition[] = [
  ...PRODUCT_MASTER_IMPORT_FIELDS,
  { key: "barcode", label: "Barcode / GTIN", required: false, type: "text", aliases: ["barcode", "gtin", "ean", "upc", "ean13", "ean_13", "Barcode", "GTIN", "EAN", "UPC"] },
  { key: "track_inventory", label: "Track Inventory", required: false, type: "text", aliases: ["inventory", "tracked", "Track Inventory"] },
  { key: "stock_quantity", label: "Stock Quantity", required: false, type: "number", aliases: ["stock", "qty", "quantity", "on hand", "Opening Stock", "opening stock", "Opening Balance", "Quantity on Hand", "on hand qty", "Initial Stock"] },
  { key: "reorder_level", label: "Reorder Level", required: false, type: "number", aliases: ["min stock", "minimum", "Reorder Level", "Min Stock", "minimum stock", "Reorder Point"] },
  { key: "reorder_quantity", label: "Reorder Quantity", required: false, type: "number", aliases: ["reorder qty", "Reorder Quantity", "Reorder Qty", "replenishment qty", "Order Quantity"] },
];

export const PRODUCT_MIGRATION_FIELDS: FieldDefinition[] = PRODUCT_MASTER_IMPORT_FIELDS;

export {
  normalizeProductType,
  createProductMasterMigrationHandler as createProductMigrationHandler,
  createProductMasterBatchMigrationHandler as createProductBatchMigrationHandler,
};

// Re-export split configs so the barrel can surface them.
export {
  PRODUCT_MASTER_IMPORT_FIELDS,
  PRODUCT_WAREHOUSE_STOCK_IMPORT_FIELDS,
  PRODUCT_BARCODE_IMPORT_FIELDS,
};
export { PRODUCT_BATCH_IMPORT_FIELDS } from "./product/productBatchImportConfig";
export { PRODUCT_PRICE_IMPORT_FIELDS } from "./product/productPriceImportConfig";
export { PRODUCT_SUPPLIER_IMPORT_FIELDS } from "./product/productSupplierImportConfig";

// ADR-0074 split batch handlers (session 6). Callers pass a
// `{ orgId, businessId, branchId? }` context object; each handler writes to
// its own destination table and never crosses concerns.
export { createProductBarcodeBatchMigrationHandler } from "./product/productBarcodeImportConfig";
export { createProductBatchBatchMigrationHandler } from "./product/productBatchImportConfig";
export { createProductWarehouseStockBatchMigrationHandler } from "./product/productWarehouseStockImportConfig";
export { createProductPriceBatchMigrationHandler } from "./product/productPriceImportConfig";
export { createProductSupplierBatchMigrationHandler } from "./product/productSupplierImportConfig";
