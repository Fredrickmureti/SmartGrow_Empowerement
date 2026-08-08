/**
 * P1 guard — stock adjustments and opening stock must resolve the inventory
 * account through the product GL ladder (ADR 0122), not the company default
 * alone and never by account `detail_type`.
 *
 * The migration below is the current definition of the three posting paths:
 *   - approve_stock_adjustment_atomic
 *   - record_opening_stock
 *   - post_stock_adjustment_gl
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const MIGRATION_DIR = "supabase/migrations";

/** Latest migration text that (re)defines the given function. */
function latestDefinitionOf(fnName: string): string {
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  const needle = `FUNCTION public.${fnName}(`;
  for (const f of files) {
    const sql = readFileSync(`${MIGRATION_DIR}/${f}`, "utf8");
    if (sql.includes(needle)) return sql;
  }
  throw new Error(`No migration defines ${fnName}`);
}

const FUNCTIONS = [
  "approve_stock_adjustment_atomic",
  "record_opening_stock",
  "post_stock_adjustment_gl",
] as const;

describe("inventory adjustment GL account ladder (ADR 0122)", () => {
  for (const fn of FUNCTIONS) {
    it(`${fn} resolves the inventory account through the ladder`, () => {
      const sql = latestDefinitionOf(fn);
      expect(sql).toContain("resolve_product_account_override");
      // The ladder's final tier is the company default, applied via COALESCE —
      // never an account lookup by detail_type.
      expect(sql).not.toMatch(/detail_type\s*=\s*'(inventory|cost_of_goods_sold)'/);
    });
  }

  it("keeps the canonical journal writer", () => {
    for (const fn of FUNCTIONS) {
      const sql = latestDefinitionOf(fn);
      expect(sql).toContain("post_journal_entry_atomic");
      expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?journal_entry_lines/i);
    }
  });
});
