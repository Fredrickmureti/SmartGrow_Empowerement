/**
 * Guard — ADR 0074. Product imports must live in split configs.
 *
 * The legacy `productImportConfig.ts` file remains as a compat shim. Existing
 * call sites (Products page, Migration step, importConfigs barrel) are
 * allowlisted. Any new file importing the legacy symbol fails this guard.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");
const ALLOWLIST = new Set([
  "src/lib/importConfigs/index.ts",
  "src/lib/importConfigs/productImportConfig.ts",
  "src/pages/Products.tsx",
  "src/components/migration/steps/MigrationStepProducts.tsx",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("ADR 0074 — product imports are split", () => {
  it("has the six split config files", () => {
    for (const f of [
      "product/productMasterImportConfig.ts",
      "product/productBarcodeImportConfig.ts",
      "product/productBatchImportConfig.ts",
      "product/productWarehouseStockImportConfig.ts",
      "product/productPriceImportConfig.ts",
      "product/productSupplierImportConfig.ts",
    ]) {
      expect(existsSync(join(ROOT, "lib/importConfigs", f))).toBe(true);
    }
  });

  it("no new callers import from the legacy productImportConfig module", () => {
    if (!existsSync(ROOT)) return;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = abs.slice(process.cwd().length + 1).replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(abs, "utf8");
      if (/importConfigs\/productImportConfig(?!\/)/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `New importers must use split configs under importConfigs/product/. Offenders: ${offenders.join(", ")}`).toEqual([]);
  });
});
