/**
 * Guard: the product form saves through ONE transaction.
 *
 * The defect this locks down: the form used to save the master row and then
 * fire three independent best-effort writes for identifiers, packaging and
 * measurements. Any failure after the first left a half-built product and a
 * "product created — packaging save failed" toast, which operators experience
 * as an edit that "did not stick".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const FORM = "src/pages/inventory/ProductForm.tsx";
const SEAM = "src/features/products/save/saveProductAtomic.ts";

const read = (p: string) => readFileSync(p, "utf8");

describe("product save is a single transaction", () => {
  it("the form goes through the atomic save seam", () => {
    const src = read(FORM);
    expect(src).toContain('from "@/features/products/save/saveProductAtomic"');
    expect(src).toContain("saveProductAtomic(");
  });

  it("the form no longer fires best-effort child commits", () => {
    const src = read(FORM);
    expect(src).not.toMatch(/identifiersRef\.current\?\.commit/);
    expect(src).not.toMatch(/packagingRef\.current\?\.commit/);
    expect(src).not.toMatch(/physicalRef\.current\?\.commit/);
  });

  it("the seam calls the atomic RPC and nothing else", () => {
    const src = read(SEAM);
    expect(src).toContain('supabase.rpc("save_product_atomic"');
    // No direct table writes may live in the save seam.
    expect(src).not.toMatch(/\.from\(["'](products|product_packaging|product_identifiers|product_physical_attributes)["']\)/);
  });

  it("raw database errors never reach the operator", () => {
    const src = read(SEAM);
    expect(src).toContain("describeProductSaveFailure");
    for (const code of [
      "PACKAGING_CYCLE",
      "PACKAGING_DEPTH",
      "PACKAGING_INCONSISTENT",
      "PACKAGING_SCOPE",
      "PRODUCT_NOT_FOUND",
    ]) {
      expect(src).toContain(code);
    }
  });
});
