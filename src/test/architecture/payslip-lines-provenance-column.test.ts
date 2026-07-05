/**
 * Architecture guard — payslip_lines provenance column contract.
 *
 * `public.payslip_lines` stores per-line provenance in the `source` (jsonb)
 * column. There is no `details` column. compute-payroll (producer) and
 * post-payroll-gl (consumer) MUST agree on the column name or the posting
 * preview and the real post silently 500 on `.select("details")` /
 * `.insert({ details: ... })`.
 *
 * This test locks the contract so the drift that caused the
 * "Posting Preview → HTTP 500" incident cannot silently return.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POST = readFileSync(
  join(process.cwd(), "supabase/functions/post-payroll-gl/index.ts"),
  "utf-8",
);
const COMPUTE = readFileSync(
  join(process.cwd(), "supabase/functions/compute-payroll/index.ts"),
  "utf-8",
);

describe("payslip_lines provenance column contract", () => {
  it("post-payroll-gl does not SELECT a non-existent `details` column from payslip_lines", () => {
    // Regex catches `.select("... details ...")` anywhere the payslip_lines
    // table is read.
    const badSelect = /from\(["']payslip_lines["']\)[\s\S]{0,200}?\.select\(["'][^"']*\bdetails\b/;
    expect(POST).not.toMatch(badSelect);
  });

  it("compute-payroll does not write a `details` key into payslip_lines rows", () => {
    // The pushLine helper is the sole writer into payslip_lines. Its row
    // literal is small (< 20 lines) — bound the match tightly so unrelated
    // `details:` strings elsewhere in the 4700-line file don't false-match.
    expect(COMPUTE).not.toMatch(
      /lineRows\.push\(\{[^{}]{0,600}?\bdetails\s*:/,
    );
  });

  it("post-payroll-gl reads provenance via `line.source`, not `line.details`", () => {
    expect(POST).not.toMatch(/\bline\.details\b/);
  });
});
