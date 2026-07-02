/**
 * Phase 4 P3 architecture guard.
 *
 * The correction link between a reversal payslip and its original is
 * managed exclusively by the atomic reversal RPC (`payroll_reverse_run_atomic`).
 * Application code MUST NOT write `corrects_payslip_id` or
 * `superseded_by_payslip_id` directly — doing so would let UI bugs create
 * "ghost paid" originals or break the lifecycle journal contract.
 *
 * This guard fails the build if any source file under `src/` or
 * `supabase/functions/` (excluding migrations and this test) sets those
 * columns through the Supabase client.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  /\.from\(\s*["']payslips["']\s*\)[\s\S]{0,400}?(corrects_payslip_id|superseded_by_payslip_id)\s*:/,
  /(corrects_payslip_id|superseded_by_payslip_id)\s*:\s*[^,\n}]+,[\s\S]{0,200}?\.from\(\s*["']payslips["']\s*\)/,
];

const SELF = "payslip-correction-link.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry) && entry !== SELF) {
      out.push(p);
    }
  }
  return out;
}

describe("Phase 4 P3 — payslip correction-link write guard", () => {
  it("forbids direct writes to corrects_payslip_id / superseded_by_payslip_id", () => {
    const files = [...walk("src"), ...walk("supabase/functions")];
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const pat of FORBIDDEN) {
        if (pat.test(src)) violations.push(file);
      }
    }
    expect(
      violations,
      `These files write payslip correction links directly. Use the payroll_reverse_run_atomic RPC instead:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
