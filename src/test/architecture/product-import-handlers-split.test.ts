/**
 * ADR 0074 — Step 6 guard.
 *
 * Enforces that each split product-import config file exports a matching
 * `create<Name>BatchMigrationHandler` factory, that none of the secondary
 * handlers reference `warehouse_stock` directly (opening balances must
 * post through `stock_adjustments` so `stock_quants` stays authoritative),
 * and that the `productImportConfig.ts` compat shim re-exports all six.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../lib/importConfigs");

const HANDLERS: Array<{ file: string; symbol: string }> = [
  { file: "product/productMasterImportConfig.ts", symbol: "createProductMasterBatchMigrationHandler" },
  { file: "product/productBarcodeImportConfig.ts", symbol: "createProductBarcodeBatchMigrationHandler" },
  { file: "product/productBatchImportConfig.ts", symbol: "createProductBatchBatchMigrationHandler" },
  { file: "product/productWarehouseStockImportConfig.ts", symbol: "createProductWarehouseStockBatchMigrationHandler" },
  { file: "product/productPriceImportConfig.ts", symbol: "createProductPriceBatchMigrationHandler" },
  { file: "product/productSupplierImportConfig.ts", symbol: "createProductSupplierBatchMigrationHandler" },
];

describe("ADR-0074 split product imports — batch handlers", () => {
  it("each split config exports its batch handler", () => {
    for (const h of HANDLERS) {
      const src = readFileSync(join(ROOT, h.file), "utf8");
      expect(src, `${h.file} must export ${h.symbol}`).toMatch(new RegExp(`export function ${h.symbol}\\b`));
    }
  });

  it("secondary handlers never write to warehouse_stock directly", () => {
    const forbidden = HANDLERS.filter((h) => h.symbol !== "createProductMasterBatchMigrationHandler");
    for (const h of forbidden) {
      const src = readFileSync(join(ROOT, h.file), "utf8");
      // Allow the comment mention in warehouseStock; forbid actual writes.
      expect(src, `${h.file} must not query warehouse_stock`).not.toMatch(/\.from\(\s*["']warehouse_stock["']/);
    }
  });

  it("productImportConfig compat shim re-exports all 6 batch handlers", () => {
    const src = readFileSync(join(ROOT, "productImportConfig.ts"), "utf8");
    for (const h of HANDLERS) {
      expect(src, `shim must re-export ${h.symbol}`).toMatch(new RegExp(h.symbol));
    }
  });
});