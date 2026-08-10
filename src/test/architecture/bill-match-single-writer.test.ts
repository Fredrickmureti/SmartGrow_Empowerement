/**
 * Ratchet — the bill matcher is a single writer.
 *
 * Step 3 of the AP remediation consolidated two matchers into one
 * (`match_bill_atomic`) and made it run automatically on submit. These
 * assertions freeze that shape in:
 *
 *  1. No client code calls the retired `match_bill_to_grn`.
 *  2. No client code writes `bill_match_results`, `bill_match_exceptions`
 *     or `bill_grn_matches` — those tables belong to the matcher.
 *  3. Exception review goes through `resolve_bill_match_exception_atomic`,
 *     not through a client-side status flip.
 *  4. `submit_bill_atomic` invokes the matcher, so match state exists
 *     before anyone can approve a bill.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes(join("src", "test")) && !f.includes("__tests__"));

describe("bill match — single writer", () => {
  it("no client code calls the retired match_bill_to_grn", () => {
    const offenders = FILES.filter((f) => readFileSync(f, "utf8").includes("match_bill_to_grn"));
    expect(offenders).toEqual([]);
  });

  it("no client code writes the match tables directly", () => {
    const TABLES = ["bill_match_results", "bill_match_exceptions", "bill_grn_matches"];
    const WRITES = /\.(insert|update|upsert|delete)\s*\(/;
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const table of TABLES) {
        const re = new RegExp(`from\\(\\s*["'\`]${table}["'\`]\\s*\\)([\\s\\S]{0,120})`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          if (WRITES.test(m[1])) offenders.push(`${file} → ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exception review goes through the canonical RPC", () => {
    const hook = readFileSync(join(SRC, "hooks", "useBillMatch.ts"), "utf8");
    expect(hook).toContain("resolve_bill_match_exception_atomic");
    expect(hook).not.toMatch(/from\(\s*["'`]bill_match_results["'`]\s*\)\s*\.\s*update/);
  });

  it("submit_bill_atomic runs the matcher", () => {
    const joined = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    const submits = joined.split(/CREATE OR REPLACE FUNCTION public\.submit_bill_atomic/);
    const latest = submits[submits.length - 1];
    expect(submits.length).toBeGreaterThan(1);
    expect(latest).toContain("match_bill_atomic");
  });

  it("match state is surfaced in the UI", () => {
    const list = readFileSync(join(SRC, "pages", "Bills.tsx"), "utf8");
    expect(list).toContain("BillMatchBadge");
    const view = readFileSync(join(SRC, "features/purchases/bills/billView.tsx"), "utf8");
    expect(view).toContain("BillMatchPanel");
  });
});
