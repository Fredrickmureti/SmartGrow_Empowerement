/**
 * Architecture guard — Phase 5 of the Product Identity remediation
 * (ADR-0110): `product_identifiers` has exactly ONE write seam.
 *
 * Reads may still select from the table (product detail, editors, admin
 * lists). Mutations may not: insert / update / upsert / delete against
 * `product_identifiers` outside
 * `src/features/products/identity/writeIdentifier.ts` bypass primary
 * uniqueness, packaging ownership and cross-product code clashes — the
 * mechanism behind "SKU edits appearing inconsistent".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const SEAM = path.join(SRC, "features/products/identity/writeIdentifier.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "test") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && full !== SEAM) {
      out.push(full);
    }
  }
  return out;
}

/** A product_identifiers query followed by a mutating verb in the chain. */
const MUTATION =
  /from\(\s*["']product_identifiers["'](?:\s+as\s+any)?\s*\)\s*(?:as\s+any\s*)?\.\s*(insert|update|upsert|delete)\b/;

describe("Phase 5 — product_identifiers has one write seam", () => {
  const files = walk(SRC);

  it("finds application sources to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source outside the identity service mutates product_identifiers", () => {
    const offenders = files.filter((f) => MUTATION.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("the seam calls the service RPCs, not the table", () => {
    const src = readFileSync(SEAM, "utf8");
    expect(src).toMatch(/upsert_product_identifier/);
    expect(src).toMatch(/retire_product_identifier/);
    expect(src).not.toMatch(/from\(\s*["']product_identifiers["']/);
  });
});