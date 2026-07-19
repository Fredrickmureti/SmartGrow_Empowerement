/**
 * S3 architecture guard — ledger-facing `pos_statements` aggregation.
 *
 * Pins the migration surface a downstream engineer might be tempted to
 * "simplify":
 *   1. `pos_statements` and `pos_statement_tender_lines` exist as separate
 *      tables (aggregate row + per-tender detail).
 *   2. Both are RLS-enabled with an explicit no-direct-write policy —
 *      writes only ever land through `open_pos_statement` /
 *      `close_pos_statement` (matches the S1 helper-only pattern).
 *   3. The RPC pair is created with SECURITY DEFINER + hardcoded
 *      `search_path = public` so the branch access check can't be
 *      shadowed.
 *   4. A shift-close trigger on `pos_shifts` materialises the statement
 *      automatically so every future close has a ledger anchor.
 *
 * S5 will layer GL posting on top; this test only guards the aggregation
 * fabric so a future migration can't quietly drop it.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function latestMigrationWith(pattern: string): string {
  const out = execSync(
    `rg -l ${JSON.stringify(pattern)} supabase/migrations`,
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration contains ${pattern}`);
  return last;
}

describe("POS statements — ledger aggregation fabric", () => {
  const sql = readFileSync(
    latestMigrationWith("CREATE TABLE IF NOT EXISTS public.pos_statements"),
    "utf8",
  );

  it("creates pos_statements with a shift FK and RLS enabled", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.pos_statements/);
    expect(sql).toMatch(/REFERENCES public\.pos_shifts\(id\)/);
    expect(sql).toMatch(
      /ALTER TABLE public\.pos_statements ENABLE ROW LEVEL SECURITY/,
    );
  });

  it("blocks direct client writes to pos_statements", () => {
    expect(sql).toMatch(
      /CREATE POLICY[^\n]*pos_statements_no_direct_write[\s\S]*?WITH CHECK \(false\)/,
    );
    expect(sql).toMatch(
      /CREATE POLICY[^\n]*pos_statements_no_direct_update[\s\S]*?USING \(false\)/,
    );
  });

  it("creates pos_statement_tender_lines with a unique per-tender key", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.pos_statement_tender_lines/,
    );
    expect(sql).toMatch(
      /UNIQUE \(statement_id, tender_method, processor\)/,
    );
  });

  it("defines open_pos_statement and close_pos_statement as SECURITY DEFINER", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.open_pos_statement[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.close_pos_statement[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public/,
    );
  });

  it("both RPCs assert branch access before touching state", () => {
    expect(sql).toMatch(
      /open_pos_statement[\s\S]*?assert_pos_caller_branch_access/,
    );
    expect(sql).toMatch(
      /close_pos_statement[\s\S]*?assert_pos_caller_branch_access/,
    );
  });

  it("materialises a statement on shift close via trigger", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_pos_open_stmt_on_close[\s\S]*?ON public\.pos_shifts/,
    );
  });

  it("backfills historical shifts as `historical` posting status", () => {
    expect(sql).toMatch(/'historical_backfill'/);
    expect(sql).toMatch(/'historical'/);
  });
});
