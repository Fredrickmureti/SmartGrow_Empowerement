/**
 * P3 guard (ADR 0122) — no posting path may read a product's GL account
 * columns directly, or resolve a posting account by `detail_type`.
 *
 * Every tier decision belongs to `resolve_product_gl_account` /
 * `resolve_product_account_override`. A function that reads
 * `products.sales_account_id` itself silently skips the category tier; one
 * that looks up accounts by `detail_type` picks an arbitrary account of the
 * right shape rather than the mapped default.
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

/** Posting paths that must delegate account resolution to the ladder. */
const POSTING_FUNCTIONS = [
  "post_pos_statement_gl",
  "approve_stock_adjustment_atomic",
  "record_opening_stock",
  "post_stock_adjustment_gl",
] as const;

const PRODUCT_ACCOUNT_COLUMNS = [
  "sales_account_id",
  "purchase_account_id",
  "cogs_account_id",
  "inventory_account_id",
];

describe("posting paths never bypass the product GL ladder", () => {
  for (const fn of POSTING_FUNCTIONS) {
    const sql = latestDefinitionOf(fn);

    it(`${fn} delegates to the ladder resolver`, () => {
      expect(sql).toMatch(/resolve_product_(gl_account|account_override)/);
    });

    it(`${fn} does not read product account columns directly`, () => {
      // Column names may appear as ladder *purposes* ('inventory_account_id'
      // never is), so only flag qualified reads off a products alias.
      for (const col of PRODUCT_ACCOUNT_COLUMNS) {
        expect(sql).not.toMatch(
          new RegExp(`\\b(p|pr|prod|products)\\.${col}\\b`, "i"),
        );
      }
    });

    it(`${fn} does not resolve accounts by detail_type`, () => {
      expect(sql).not.toMatch(/detail_type/i);
    });
  }
});
