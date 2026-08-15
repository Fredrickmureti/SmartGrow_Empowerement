/**
 * Architecture guard — product unit labels must come from the canonical
 * `base_uom_id → units_of_measure` relation, never from a phantom
 * `products.unit_of_measure` column with an "ea" fallback.
 *
 * Why this test exists: `products` has NO `unit_of_measure` column. Ten UI
 * sites read `(product as any).unit_of_measure ?? "ea"`, which always
 * evaluated to `undefined ?? "ea"`. Every product — including ones stocked
 * in kilograms, litres or metres — rendered as "383 ea". The fallback made
 * a data-shape bug look like a configuration default, so it survived for
 * months. A product with no base UoM configured is a defect and must render
 * the visible `(no UoM)` marker instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("product base UoM labelling", () => {
  it("no source file falls back to \"ea\" for a product's unit_of_measure", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      if (/unit_of_measure\s*\?\?\s*["']ea["']/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      "products.unit_of_measure does not exist; use productBaseLabelOrUnset(product) " +
        "with PRODUCT_BASE_UOM_SELECT joined into the query",
    ).toEqual([]);
  });

  it("productBaseLabel reports missing configuration instead of inventing \"ea\"", async () => {
    const { productBaseLabel, productBaseLabelOrUnset, UOM_UNSET_LABEL } = await import(
      "@/lib/inventory/uom"
    );
    expect(productBaseLabel({ base_uom: { code: "kg", name: "Kilogram" } })).toBe("kg");
    expect(productBaseLabel({ base_uom: { code: null, name: "Tablet" } })).toBe("Tablet");
    expect(productBaseLabel({})).toBeNull();
    expect(productBaseLabel(null)).toBeNull();
    expect(productBaseLabelOrUnset({})).toBe(UOM_UNSET_LABEL);
    expect(UOM_UNSET_LABEL).not.toBe("ea");
  });

  it("product queries feeding quantity displays join the base UoM relation", () => {
    const required = [
      "src/hooks/useProducts.ts",
      "src/hooks/inventory/useProductDetailData.ts",
      "src/pages/Inventory.tsx",
      "src/hooks/inventory/useDashboardIntelligence.ts",
    ];
    for (const file of required) {
      expect(
        readFileSync(file, "utf8"),
        `${file} renders product quantities but does not select the base UoM`,
      ).toContain("PRODUCT_BASE_UOM_SELECT");
    }
  });
});
