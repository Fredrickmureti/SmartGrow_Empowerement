/**
 * ADR-0062 (Submission format parity) — runtime + wiring guard.
 *
 * The government-portal xlsx/csv/xml files are rendered by
 * `_shared/govFileWriter.ts`, which reads each column via
 * `returnSourceResolver.readSource`. So the parity contract we need to
 * pin is: for the same fixture, `sum_gross_amount` and
 * `sum_taxable_amount` MUST resolve to distinct values, and the
 * `readSource` call the writer performs is exactly what we assert on.
 *
 * We also static-check that the generator still carries the
 * `RETURN_TEMPLATE_SOURCE_MISMATCH` guard that blocks a template
 * whose `body.columns` and `submission_format.columns` disagree on
 * the canonical source for the same logical column — removing it
 * resurrects the six-month NSSF-return defect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSource, type SourceContext } from "../../../supabase/functions/_shared/returnSourceResolver";

const ctx: SourceContext = {
  employee: { first_name: "Asha", last_name: "Mwangi" },
  sums: {
    employee: 9_635,
    employer: 4_935,
    gross: 94_000,
    taxable: 84_365.06,
    basic: 80_000,
    allowances: 14_000,
    payslipCount: 1,
    byRule: {},
    byComponent: {},
    byColumn: {},
  },
};

describe("ADR-0062 amendment — submission_format parity", () => {
  it("govFileWriter's per-cell source resolution returns gross (94,000) for sum_gross_amount, taxable (84,365.06) for sum_taxable_amount", () => {
    // These are the exact calls govFileWriter.ts makes per column
    // (see line 83 / 120: `readSource(c.source, ctx)`).
    expect(readSource("sum_gross_amount", ctx)).toBe(94_000);
    expect(readSource("sum_taxable_amount", ctx)).toBeCloseTo(84_365.06, 2);
    expect(readSource("sum_gross_amount", ctx)).not.toBe(
      readSource("sum_taxable_amount", ctx),
    );
  });

  it("generate-statutory-return still carries the RETURN_TEMPLATE_SOURCE_MISMATCH guard for both column lists", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/generate-statutory-return/index.ts"),
      "utf8",
    );
    expect(src).toContain("RETURN_TEMPLATE_SOURCE_MISMATCH");
    // A guard that only reads one side is the bug it's supposed to
    // prevent. Both column lists must be inspected.
    expect(src).toMatch(/submission_format/);
    expect(src).toMatch(/body_source/);
    expect(src).toMatch(/submission_source/);
  });
});
