/**
 * Regression pin — the country-neutral ANNUAL_EARNINGS_STATEMENT must be
 * rendered from AnnualEarningsStatementDTO only. The base annual statement
 * template is presentation: no rule-code list, no amount-field switch, and
 * no `derived_columns` formula path that can compete with DTO.months.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function extractJsonBodies(sql: string): unknown[] {
  const bodies: unknown[] = [];
  const re = /\$json\$([\s\S]*?)\$json\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    try {
      bodies.push(JSON.parse(m[1]));
    } catch {
      /* ignore non-body dollar-quoted blocks */
    }
  }
  return bodies;
}

function findLatestAnnualEarningsBody(): any | null {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let latest: any = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const body of extractJsonBodies(sql)) {
      if ((body as any)?.code === "ANNUAL_EARNINGS_STATEMENT") latest = body;
    }
  }
  return latest;
}

describe("ANNUAL_EARNINGS_STATEMENT — country-neutral canonical binding", () => {
  const body = findLatestAnnualEarningsBody();

  it("a v3 template body ships in migrations", () => {
    expect(body).toBeTruthy();
    expect(body.schema_version).toBeGreaterThanOrEqual(3);
  });

  it("its monthly matrix binds DTO.months directly, without formula metadata", () => {
    const matrix = (body.document as any[]).find((n) => n.type === "matrix");
    expect(matrix, "template must include a matrix node").toBeTruthy();
    expect(matrix.rows_binding).toBe("months");
    expect(matrix.rule_codes ?? []).toEqual([]);
    expect(matrix.amount_field).toBeUndefined();
    expect(matrix.derived_columns).toBeUndefined();
  });

  it("every visible monthly data column is a canonical DTO.months key", () => {
    const matrix = (body.document as any[]).find((n) => n.type === "matrix");
    const keys = (matrix.columns as any[]).map((c) => String(c.key));
    expect(keys).toEqual([
      "month",
      "gross",
      "benefits",
      "taxable",
      "statutory_employee",
      "statutory_employer",
      "other_deductions",
      "reliefs",
      "net",
    ]);
  });

  it("generate-tax-certificate cannot overwrite annual DTO months via legacy matrix assembly", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase", "functions", "generate-tax-certificate", "index.ts"),
      "utf8",
    );
    expect(src).toContain('template.code !== "ANNUAL_EARNINGS_STATEMENT"');
  });

  it("binds YTD employer contributions to the canonical aggregate field", () => {
    const ytd = (body.document as any[]).find(
      (n) => n.type === "section" && n.title?.value === "Year-to-Date Summary",
    );
    expect(ytd, "template must include the YTD summary section").toBeTruthy();
    const employerContributionRow = (ytd.children as any[]).find(
      (n) => n.type === "key_value" && n.label?.value === "Total Employer Contributions",
    );
    expect(employerContributionRow?.value?.path).toBe("ytd.employer_contributions_total");
  });

  it("does not mark YTD summary rows optional", () => {
    const ytd = (body.document as any[]).find(
      (n) => n.type === "section" && n.title?.value === "Year-to-Date Summary",
    );
    const optionalRows = (ytd.children as any[])
      .filter((n) => n.type === "key_value" && n.optional === true)
      .map((n) => n.label?.value ?? n.value?.path);
    expect(optionalRows).toEqual([]);
  });
});
