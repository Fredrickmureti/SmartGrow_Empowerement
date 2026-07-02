/**
 * Inventory stock-adjustment GL posting must go through the canonical
 * `post_journal_entry_atomic` RPC. A raw `INSERT INTO journal_entries`
 * inside `approve_stock_adjustment_atomic` previously omitted
 * `entry_number`, which violated the NOT NULL constraint and rolled
 * back the whole product-creation + opening-stock workflow.
 *
 * This test guards the migration that fixed it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(
  "supabase/migrations/20260522154328_2826129e-becb-47ae-ae02-dcc76c690134.sql",
  "utf8",
);

describe("approve_stock_adjustment_atomic posting path", () => {
  it("routes GL posting through the canonical post_journal_entry_atomic RPC", () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.approve_stock_adjustment_atomic/);
    expect(MIGRATION).toContain("post_journal_entry_atomic");
    expect(MIGRATION).toContain("get_next_journal_entry_number");
  });

  it("does not bypass the canonical writer with a raw journal insert", () => {
    expect(MIGRATION).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(MIGRATION).not.toMatch(/INSERT\s+INTO\s+journal_entry_lines/i);
    expect(MIGRATION).not.toMatch(/\bdebit_amount\b/);
    expect(MIGRATION).not.toMatch(/\bcredit_amount\b/);
  });

  it("matches the product form contract for opening stock", () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.create_product_with_opening_stock_atomic/);
    expect(MIGRATION).toContain("The UI captures opening stock per warehouse");
    expect(MIGRATION).toMatch(/FOR v_wh IN[\s\S]*jsonb_array_elements\(v_items_arr\)/);
    expect(MIGRATION).toContain("Opening stock may legitimately be zero-value inventory");
    expect(MIGRATION).toMatch(/organization_id, business_id, branch_id, product_id, movement_type/);
  });
});