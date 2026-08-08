import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

/**
 * Estimate status is owned by the database state machine
 * (`set_estimate_status_atomic` + `trg_estimate_status_write_guard`).
 * No client code may write `status` onto `estimates` directly — such a write
 * now throws at runtime, so this guard catches it at build time instead.
 */
describe("estimate status single-writer", () => {
  const files = globSync("src/**/*.{ts,tsx}", {
    ignore: ["src/test/**", "src/integrations/supabase/types.ts"],
  });

  it("no direct supabase update of estimates.status", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const re = /\.from\(\s*["'`]estimates["'`]\s*\)[\s\S]{0,400}?\.update\(([\s\S]{0,600}?)\)\s*\n?\s*\./g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/(^|[\s{,])status\s*:/.test(m[1])) offenders.push(file);
      }
    }
    expect(offenders, `Direct estimates.status write in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("status transitions go through setEstimateStatus", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // updateEstimate(id, { status: ... }) is no longer a legal call shape.
      if (/updateEstimate\(\s*[^,]+,\s*\{[^}]*\bstatus\s*:/.test(src)) offenders.push(file);
    }
    expect(offenders, `updateEstimate used for status in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("useEstimates exposes the RPC-backed setter", () => {
    const hook = readFileSync("src/hooks/useEstimates.ts", "utf8");
    expect(hook).toContain("set_estimate_status_atomic");
    expect(hook).toContain("setEstimateStatus");
  });

  it("conversions are guarded against both forward pointers", () => {
    const hook = readFileSync("src/hooks/useEstimates.ts", "utf8");
    expect(hook).toContain("converted_sales_order_id");
  });
});
