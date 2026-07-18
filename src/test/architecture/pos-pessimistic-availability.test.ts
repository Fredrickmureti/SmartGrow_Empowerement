/**
 * Architecture guard — Phase 3 · Batch T4/T6b.
 *
 * The POS sale AND return paths must both take a per-(product,warehouse)
 * pg_advisory_xact_lock BEFORE reading availability or rebuilding lot
 * state. Without this, concurrent sale/return of the same SKU can
 * over-commit stock or leave lot layers inconsistent.
 *
 * This test asserts the latest migration body of each RPC references
 * pg_advisory_xact_lock keyed on the product+warehouse composite.
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

function latestDefiningFile(fnName: string): string {
  const files = rgFiles(
    `FUNCTION public.${fnName}\\(`,
    "supabase/migrations",
  ).sort();
  return files[files.length - 1] ?? "";
}

function bodyOf(sql: string, fnName: string): string {
  const re = new RegExp(
    `CREATE(?:\\s+OR\\s+REPLACE)?\\s+FUNCTION\\s+public\\.${fnName}[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "i",
  );
  return sql.match(re)?.[1] ?? "";
}

describe("POS Transaction Engine — pessimistic availability locking", () => {
  it.each([
    ["process_pos_transaction"],
    ["process_pos_return"],
    ["process_pos_void"],
  ])(
    "%s takes pg_advisory_xact_lock on (product, warehouse)",
    (fnName) => {
      const file = latestDefiningFile(fnName);
      expect(file, `${fnName} not found in migrations`).not.toEqual("");
      const body = bodyOf(readFileSync(file, "utf8"), fnName);
      expect(body).toMatch(/pg_advisory_xact_lock\s*\(/);
      expect(body).toMatch(
        /hashtextextended\s*\(\s*[^)]*product[^)]*warehouse/i,
      );
    },
  );
});
