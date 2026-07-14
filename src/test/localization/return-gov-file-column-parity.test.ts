/**
 * ADR-0062 (Submission format parity) — runtime + wiring guard.
 *
 * Verifies two things:
 *
 * 1. `renderGovFile` reads GROSS PAY from `sum_gross_amount` (94,000),
 *    not `sum_taxable_amount` (84,365.06), when the submission_format
 *    column is correctly bound. This is the XLSX contract test for the
 *    corrected NSSF_RET descriptor.
 *
 * 2. `generate-statutory-return/index.ts` still carries the
 *    `RETURN_TEMPLATE_SOURCE_MISMATCH` guard that blocks generation
 *    when `body.columns` and `submission_format.columns` disagree on
 *    the canonical source for the same logical column. Removing the
 *    guard resurrects the six-month NSSF defect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderGovFile } from "../../../supabase/functions/_shared/govFileWriter";
import type { SourceContext } from "../../../supabase/functions/_shared/returnSourceResolver";

const empty = (): SourceContext["sums"] => ({
  employee: 0,
  employer: 0,
  gross: 0,
  taxable: 0,
  basic: 0,
  allowances: 0,
  payslipCount: 0,
  byRule: {},
  byComponent: {},
  byColumn: {},
});

async function readCell(source: string): Promise<number> {
  const ctx: SourceContext = {
    employee: { first_name: "Asha", last_name: "Mwangi" },
    sums: {
      ...empty(),
      gross: 94_000,
      taxable: 84_365.06,
      payslipCount: 1,
    },
  };
  const out = await renderGovFile(
    {
      type: "gov_xlsx",
      columns: [
        { header: "GROSS PAY", source, format: "fixed2" },
      ],
    },
    [ctx],
  );
  expect(out).not.toBeNull();
  // Decode the xlsx sheet: parse the sharedStrings + sheet1 minimally
  // via a well-known helper. We reuse the writer's contract: the first
  // (and only) numeric cell is the value we asked for.
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(out!.bytes);
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  // The generator writes numeric cells as <c t="n" ...><v>NUMBER</v></c>.
  // Grab all <v>…</v> and return the last one (the header is a string,
  // stored as sharedString reference, not a <v> numeric).
  const values = Array.from(sheet.matchAll(/<v>([^<]+)<\/v>/g)).map((m) => m[1]);
  const numeric = values.map(Number).filter((n) => Number.isFinite(n) && n > 1000);
  return numeric[numeric.length - 1];
}

describe("ADR-0062 amendment — submission_format parity", () => {
  it("renderGovFile emits gross (94,000) when column is bound to sum_gross_amount", async () => {
    const cell = await readCell("sum_gross_amount");
    expect(cell).toBe(94_000);
  });

  it("renderGovFile would emit taxable (84,365.06) if bound to sum_taxable_amount — proves the sources are truly distinct", async () => {
    const cell = await readCell("sum_taxable_amount");
    expect(cell).toBeCloseTo(84_365.06, 2);
    expect(cell).not.toBe(94_000);
  });

  it("generate-statutory-return still carries the RETURN_TEMPLATE_SOURCE_MISMATCH guard", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/generate-statutory-return/index.ts"),
      "utf8",
    );
    expect(src).toContain("RETURN_TEMPLATE_SOURCE_MISMATCH");
    // Both column lists must be inspected — a guard that only reads
    // one side is the bug it's supposed to prevent.
    expect(src).toMatch(/submission_format/);
    expect(src).toMatch(/body_source/);
    expect(src).toMatch(/submission_source/);
  });
});
