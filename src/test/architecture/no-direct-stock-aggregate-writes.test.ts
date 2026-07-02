/**
 * Stage D.13 — Architecture guard
 *
 * No source file outside the legitimate writers may insert/update
 * `products.stock_quantity`, `products.reorder_level`, or
 * `products.reorder_quantity` directly.
 *
 * The legitimate writers are:
 *   - The DB trigger `update_product_stock` (PG-side, not in src/)
 *   - The `record_opening_stock` RPC (PG-side, called from helpers)
 *   - Per-warehouse reorder threshold UI writes go to `warehouse_stock`,
 *     never to `products`.
 *
 * Why: writing to `products.stock_quantity` from the app puts the cached
 * company-wide aggregate out of sync with `warehouse_stock`. The trigger
 * then keeps applying deltas to a wrong base forever. Writes to
 * `products.reorder_level` from the app create a second source of truth
 * for the per-warehouse `warehouse_stock.reorder_level` column.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPES = ["src/hooks", "src/pages", "src/components"];

// Files allowed to mention these column names (display reads, types, etc.).
// What is NEVER allowed is an `.update({...stock_quantity...})` or
// `.insert({...stock_quantity...})` against the `products` table.
const ALLOWLIST = new Set<string>([
  // Migration tooling: pre-existing data import path.
  "src/components/migration/steps/MigrationStepInventory.tsx",
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// Match `.from("products")` followed (within ~600 chars) by `.update(...)` or
// `.insert(...)` whose payload mentions one of the protected columns.
const PROTECTED = /(stock_quantity|reorder_level|reorder_quantity)/;
const PRODUCTS_WRITE = /\.from\(\s*["']products["']\s*\)[\s\S]{0,800}?\.(update|insert|upsert)\s*\(([\s\S]{0,800}?)\)/g;

describe("no direct writes to products stock/reorder aggregates", () => {
  it("no file mutates products.stock_quantity / reorder_level / reorder_quantity", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        if (ALLOWLIST.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        let m: RegExpExecArray | null;
        const re = new RegExp(PRODUCTS_WRITE);
        while ((m = re.exec(src)) !== null) {
          const payload = m[2] ?? "";
          if (PROTECTED.test(payload)) {
            offenders.push(`${rel}: writes ${payload.match(PROTECTED)?.[1]} to products`);
          }
        }
      }
    }
    expect(
      offenders,
      `These files write protected aggregate columns directly to the products ` +
        `table. Use record_opening_stock for opening balances and ` +
        `warehouse_stock.reorder_level for per-warehouse thresholds.\n\n` +
        `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
