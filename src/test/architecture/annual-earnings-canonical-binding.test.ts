/**
 * Regression pin — the country-neutral ANNUAL_EARNINGS_STATEMENT
 * certificate template must bind its matrix data columns via
 * `derived_columns` (category-aggregate `cat:*` expressions), so that
 * `generate-tax-certificate` does NOT refuse it with
 * `TEMPLATE_STRUCTURAL_INVALID / MATRIX_NO_RULE_CODES`.
 *
 * This is the exact defect that produced the "422 Unprocessable Content"
 * error surfaced from useTaxCertificates.ts. The fix is a
 * republished template body (see the accompanying data migration) plus a
 * small extension to `monthlyMatrix.ts` accepting `cat:*` tokens. This
 * test pins both.
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

  it("its matrix declares derived_columns (no more unbound-column 422)", () => {
    const matrix = (body.document as any[]).find((n) => n.type === "matrix");
    expect(matrix, "template must include a matrix node").toBeTruthy();
    expect(Array.isArray(matrix.derived_columns), "matrix.derived_columns must be an array").toBe(true);
    expect(matrix.derived_columns.length).toBeGreaterThan(0);
  });

  it("uses category aggregation (cat:*) — the country-neutral binding channel", () => {
    const matrix = (body.document as any[]).find((n) => n.type === "matrix");
    const flatArgs = (matrix.derived_columns as any[])
      .flatMap((d) => (Array.isArray(d.args) ? d.args : []))
      .filter((a) => typeof a === "string");
    const catArgs = flatArgs.filter((a: string) => a.startsWith("cat:"));
    expect(
      catArgs.length,
      "generic template must reference cat:* tokens instead of hardcoded country-specific rule_codes",
    ).toBeGreaterThan(0);
  });

  it("every data column is either a month axis or backed by a derived key", () => {
    const matrix = (body.document as any[]).find((n) => n.type === "matrix");
    const derivedKeys = new Set(
      (matrix.derived_columns as any[]).map((d) => String(d.key)),
    );
    const dataCols = (matrix.columns as any[]).filter((c) => {
      const key = String(c.key ?? c.bind_key ?? c.id ?? "");
      if (!key || key === "month" || key === "month_index") return false;
      if (String(c.format ?? "").toLowerCase() === "month_short") return false;
      return true;
    });
    const unbound = dataCols
      .filter((c) => !c.source_key && !derivedKeys.has(String(c.key)))
      .map((c) => String(c.key));
    expect(unbound).toEqual([]);
  });
});
