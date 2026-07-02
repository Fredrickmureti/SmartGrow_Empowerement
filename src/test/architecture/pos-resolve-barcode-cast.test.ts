/**
 * Regression guard for the 2026-05-18 "invalid barcode for every scan" bug.
 *
 * Root cause: the latest definition of `pos_resolve_barcode` returned
 * `tax_rates.etims_tax_code` (which is `varchar(1)` in this schema) into a
 * `RETURNS TABLE (... etims_tax_code text ...)` column. PostgreSQL aborts
 * any such `RETURN QUERY` with 42804, and the POS frontend caught the
 * error and surfaced it to cashiers as "invalid barcode" — making every
 * scan look broken even when the product clearly existed.
 *
 * This test reads the LATEST migration that (re)defines
 * `public.pos_resolve_barcode` and asserts that the body explicitly casts
 * `etims_tax_code` to text. A future migration that drops that cast (or
 * removes the function and recreates it without one) will fail the build
 * here before it can ever reach a cashier.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");

function latestPosResolveBarcodeBody(): string | null {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const src = readFileSync(path.join(MIGRATIONS_DIR, files[i]), "utf8");
    if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.pos_resolve_barcode\s*\(/i.test(src)) {
      return src;
    }
  }
  return null;
}

describe("pos_resolve_barcode RETURN QUERY column casts", () => {
  const body = latestPosResolveBarcodeBody();

  it("a migration defining pos_resolve_barcode must exist", () => {
    expect(body).not.toBeNull();
  });

  it("must explicitly cast etims_tax_code to text in the RETURN QUERY", () => {
    // Matches `tr.etims_tax_code::text` (with or without an alias) so a
    // future schema change cannot silently re-introduce the 42804 bug.
    expect(body!).toMatch(/etims_tax_code\s*::\s*text/i);
  });
});
