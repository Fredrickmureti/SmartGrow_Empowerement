/**
 * Architecture guard — POS product read seam (plan Phase 1, finding F1).
 *
 * POS must consume products through the canonical server seam
 * (`list_products_with_branch_stock` for the grid, `pos_resolve_scan` for
 * scans). Direct `products` table selects inside POS code re-create a
 * competing product representation and drop the UoM / packaging contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/hooks/pos", "src/apps/pos", "src/components/pos", "src/pages/pos"];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("POS product read seam", () => {
  const files = ROOTS.flatMap(walk);

  it("scans a non-empty POS surface", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never selects from the products table directly", () => {
    const offenders = files.filter((f) =>
      /from\(\s*["'`]products["'`]\s*\)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders, `POS must read products via the canonical RPC seam: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps the grid read on the canonical RPC", () => {
    const src = readFileSync("src/hooks/pos/usePOSProducts.ts", "utf8");
    expect(src).toContain("list_products_with_branch_stock");
    expect(src).not.toMatch(/from\(\s*["'`]products["'`]\s*\)/);
  });
});
