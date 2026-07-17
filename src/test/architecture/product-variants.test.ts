/**
 * Phase E architecture guard — Product Variants (ADR 0072).
 *
 * Locks the doctrine: variants are first-class products joined by
 * `variant_parent_id`; parents are never transacted against; the panel
 * is mounted in the product form; matrix generation is pure and tested.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

describe("Phase E — Product Variants doctrine", () => {
  it("ADR 0072 is present and accepted", () => {
    const p = join(ROOT, "docs/adr/0072-product-variants.md");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf8");
    expect(body).toMatch(/Status:\s*Accepted/);
    expect(body).toMatch(/variant_parent_id/);
  });

  it("migration adds the three variant fields to products", () => {
    const dir = join(ROOT, "supabase/migrations");
    expect(existsSync(dir)).toBe(true);
    const hits = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .filter(
        (b) =>
          b.includes("variant_parent_id") &&
          b.includes("is_variant_parent") &&
          b.includes("variant_axis_values"),
      );
    expect(hits.length).toBeGreaterThan(0);
    const migration = hits[0];
    expect(migration).toMatch(/chk_variant_parent_not_self/);
    expect(migration).toMatch(/chk_parent_xor_child/);
    expect(migration).toMatch(/CREATE TABLE public\.product_variant_axes/);
    expect(migration).toMatch(
      /CREATE TABLE public\.product_variant_axis_values/,
    );
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/GRANT[\s\S]+product_variant_axes TO authenticated/);
    expect(migration).toMatch(
      /GRANT[\s\S]+product_variant_axis_values TO authenticated/,
    );
  });

  it("product form imports the variants panel", () => {
    const src = readFileSync(
      join(ROOT, "src/pages/inventory/ProductForm.tsx"),
      "utf8",
    );
    expect(src).toMatch(/ProductVariantsPanel/);
  });

  it("matrix generator is pure — no supabase / network imports", () => {
    const src = readFileSync(
      join(ROOT, "src/features/inventory/variants/generateVariantMatrix.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ['"]@\/integrations\/supabase/);
    expect(src).not.toMatch(/fetch\(/);
  });

  it("panel writes children with variant_parent_id and skips parent from being a child", () => {
    const src = readFileSync(
      join(
        ROOT,
        "src/features/inventory/variants/ProductVariantsPanel.tsx",
      ),
      "utf8",
    );
    expect(src).toMatch(/variant_parent_id:\s*productId/);
    expect(src).toMatch(/is_variant_parent:\s*false/);
    // Parent flag is flipped through the product row, not spoofed client-side.
    expect(src).toMatch(/is_variant_parent:\s*true/);
  });
});
