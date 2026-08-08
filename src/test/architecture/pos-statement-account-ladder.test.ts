/**
 * P1 guard — POS statement posting must resolve revenue, COGS and inventory
 * through the product GL ladder (ADR 0122), and must relieve inventory for
 * stock-tracked items instead of posting revenue only.
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

describe("POS statement GL account ladder (ADR 0122)", () => {
  const sql = latestDefinitionOf("post_pos_statement_gl");

  it("resolves revenue, cogs and inventory through the ladder", () => {
    expect(sql).toContain("resolve_product_account_override");
    for (const purpose of ["'sales_revenue'", "'cogs'", "'inventory'"]) {
      expect(sql).toContain(purpose);
    }
  });

  it("never resolves posting accounts by detail_type", () => {
    expect(sql).not.toMatch(/detail_type/i);
  });

  it("relieves inventory for stock-tracked items", () => {
    expect(sql).toMatch(/track_inventory/);
    expect(sql).toMatch(/POS inventory relief/);
    expect(sql).toMatch(/POS cost of goods sold/);
  });

  it("keeps the statement total authoritative for revenue", () => {
    // Residual allocation: the last bucket takes total minus what was assigned.
    expect(sql).toContain("v_net_revenue - v_alloc_sum");
  });

  it("still posts through the atomic journal entry helper", () => {
    expect(sql).toContain("post_journal_entry_atomic");
  });
});
