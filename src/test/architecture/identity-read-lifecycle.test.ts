/**
 * Guard: identifier reads must be lifecycle-aware.
 *
 * `product_identifiers` rows are archived, never deleted, when an operator
 * retires a code. Any operator-facing read that omits the status predicate
 * renders retired identifiers as live ones — the duplicate-identifier class
 * of defect. Reads must go through
 * `@/features/products/identity/activeIdentifiers` or carry an explicit
 * status filter.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";


const SEAM = "src/features/products/identity/activeIdentifiers.ts";

/** Files allowed to query the table without the shared selector. */
const ALLOWLIST = new Set<string>([
  SEAM,
  // Resolver/offline/import paths carry their own lifecycle predicates and
  // deliberately read non-active rows.
  "src/lib/gs1/identityCodes.ts",
  "src/services/offline/SQLiteBridge.ts",
  "src/lib/importConfigs/product/_resolveProduct.ts",
  "src/lib/importConfigs/product/productBarcodeImportConfig.ts",
  "src/features/products/identity/useSupplierCodeDiscovery.ts",
  "src/features/products/identity/writeIdentifier.ts",
  "src/hooks/useProductIdentifiersRealtimeSync.ts",
  "src/pages/pos/POSBarcodeSettings.tsx",
  "src/components/products/ProductPackagingEditor.tsx",
  "src/components/products/PackagingSelect.tsx",
]);

function sourceFiles(): string[] {
  const out = execSync(
    `grep -rl 'from("product_identifiers")' src --include=*.ts --include=*.tsx || true`,
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("/test/") && !f.includes("__tests__"));
}

describe("product identifier reads are lifecycle-aware", () => {
  it("no unfiltered .from('product_identifiers') select outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (ALLOWLIST.has(file)) continue;
      const src = readFileSync(file, "utf8");
      if (!/\.eq\(\s*["']status["']/.test(src)) offenders.push(file);
    }
    expect(offenders, `Use activeIdentifiersForProduct() in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the shared selector filters to active", () => {
    const src = readFileSync(SEAM, "utf8");
    expect(src).toContain('.eq("status", ACTIVE_IDENTIFIER_STATUS)');
  });

  it("operator-facing surfaces use the shared selector", () => {
    for (const file of [
      "src/components/products/ProductIdentifiersEditor.tsx",
      "src/hooks/inventory/useProductDetailData.ts",
    ]) {
      expect(readFileSync(file, "utf8")).toContain("activeIdentifiersForProduct");
    }
  });
});
