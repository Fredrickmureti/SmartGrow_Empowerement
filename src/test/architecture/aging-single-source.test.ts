import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * ADR 0027 guard: AR/AP aging has exactly ONE client-side bucket-boundary
 * implementation (`src/services/finance/aging.ts`) and exactly one read
 * projection (`finance_ar_open_items` / `finance_ap_open_items`).
 *
 * These tests exist because divergent inline copies of "days overdue <= 30"
 * are how the AR total silently stops matching the aging report.
 */

const ROOT = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("aging single source of truth", () => {
  const files = walk(ROOT);

  it("exposes canonical bucket keys and labels", () => {
    const src = readFileSync(join(ROOT, "services/finance/aging.ts"), "utf8");
    for (const key of ["not_due", "current", "days30", "days60", "days90"]) {
      expect(src).toContain(key);
    }
    expect(src).toContain("AGING_BUCKET_LABELS");
  });

  it("statement hooks read aging from the ledger projection, not raw documents", () => {
    for (const hook of ["hooks/useCustomerStatements.ts", "hooks/useVendorStatements.ts"]) {
      const src = readFileSync(join(ROOT, hook), "utf8");
      expect(src).toContain("fetchContactOpenItemAging");
      expect(src).not.toMatch(/agingBuckets\.(days30|days60|days90)\s*\+=/);
    }
  });

  it("no file outside the aging service re-derives legacy bucket field names", () => {
    const offenders = files
      .filter((f) => !f.endsWith(join("services", "finance", "aging.ts")))
      .filter((f) => /days_1_30|days_31_60|days_61_90|days_90_plus/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
