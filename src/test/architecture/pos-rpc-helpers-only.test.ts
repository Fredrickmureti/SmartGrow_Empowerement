/**
 * Architecture guard — Phase 3 · Batch T6 completion.
 *
 * The POS Transaction Engine RPCs `process_pos_transaction` and
 * `process_pos_return` MUST route every line insert, payment record, and
 * stock movement through the internal helpers so behaviour cannot drift
 * between the sale and return paths:
 *
 *   _pos_insert_line             — pos_transaction_items writes
 *   _pos_record_payment          — pos_transaction_payments writes
 *   _pos_apply_lot_consumption   — stock_movements / lot consumption
 *   _pos_write_stock_movement    — physical movement row
 *
 * This test locks that invariant into the latest migration definition of
 * the two RPCs by scanning migrations that (re)define them. It intentionally
 * matches on the RPC body — any future migration that re-inlines an
 * INSERT into pos_transaction_items or pos_transaction_payments inside
 * these RPCs fails the build.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function rgFiles(pattern: string, path: string): string[] {
  try {
    return execSync(
      `rg -l --no-messages ${JSON.stringify(pattern)} ${JSON.stringify(path)}`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function latestMigrationDefining(fnSig: string): string {
  const files = rgFiles(fnSig, "supabase/migrations").sort();
  return files[files.length - 1] ?? "";
}

function extractFunctionBody(sql: string, fnName: string): string {
  // Grab from CREATE ... FUNCTION public.<fnName> up to the next matching $$;
  const re = new RegExp(
    `CREATE(?:\\s+OR\\s+REPLACE)?\\s+FUNCTION\\s+public\\.${fnName}[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "i",
  );
  const m = sql.match(re);
  return m?.[1] ?? "";
}

describe("POS Transaction Engine — RPCs must use internal helpers", () => {
  it.each([
    ["process_pos_transaction"],
    ["process_pos_return"],
  ])("%s contains no inline pos_transaction_items INSERT", (fnName) => {
    const file = latestMigrationDefining(
      `FUNCTION public.${fnName}\\(`,
    );
    expect(file, `no migration defines ${fnName}`).not.toEqual("");
    const body = extractFunctionBody(readFileSync(file, "utf8"), fnName);
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.pos_transaction_items/i);
    expect(body).not.toMatch(
      /INSERT\s+INTO\s+public\.pos_transaction_payments/i,
    );
    // Positive assertion — helpers ARE referenced.
    expect(body).toMatch(/_pos_insert_line\s*\(/);
    expect(body).toMatch(/_pos_record_payment\s*\(/);
  });

  it("helpers are defined with restricted grants", () => {
    const helpers = [
      "_pos_insert_line",
      "_pos_record_payment",
      "_pos_apply_lot_consumption",
    ];
    for (const h of helpers) {
      const file = latestMigrationDefining(
        `FUNCTION public.${h}\\(`,
      );
      expect(file, `no migration defines helper ${h}`).not.toEqual("");
    }
  });
});
