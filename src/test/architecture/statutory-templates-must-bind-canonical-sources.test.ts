/**
 * Architecture guard — statutory certificate templates must bind their
 * matrix data columns to canonical payroll rule codes.
 *
 * Root cause of the KE P9A "Personal Relief / Insurance Relief = 0,
 * PAYE = pre-relief" defect: a localization pack was republished with a
 * v3 `matrix` node whose data columns had neither `source_key` nor a
 * `derived_columns` entry, and whose matrix-level `rule_codes` list was
 * absent. `collectMatrixRuleCodes()` therefore returned an empty set,
 * `payroll_employee_monthly_breakdown` was never asked for the relief
 * rule codes, and the resolver silently rendered zero on a filed
 * statutory document.
 *
 * This test statically walks every localization pack certificate
 * template body embedded in the migration set and refuses to allow any
 * future certificate to ship with an unbound matrix column. It is
 * country-agnostic — the same invariant governs KE P9A, GH PAYE,
 * ANNUAL_EARNINGS_STATEMENT, and every certificate published from any
 * pack.
 *
 * If this test fails, the fix is in the pack (author `source_key` /
 * `rule_codes` / `derived_columns`), never in the payroll engine.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface MatrixColumn {
  key?: string;
  source_key?: string | null;
  format?: string;
}
interface MatrixNode {
  type: "matrix";
  columns?: MatrixColumn[];
  rule_codes?: string[];
  derived_columns?: Array<{ key: string }>;
}

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

function walkMatrices(node: any, out: MatrixNode[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "matrix") out.push(node as MatrixNode);
  if (Array.isArray(node.children)) node.children.forEach((c: any) => walkMatrices(c, out));
  if (Array.isArray(node.column_children)) {
    node.column_children.forEach((col: any) => Array.isArray(col) && col.forEach((c) => walkMatrices(c, out)));
  }
  if (Array.isArray(node.document)) node.document.forEach((c: any) => walkMatrices(c, out));
}

function isDataColumn(c: MatrixColumn): boolean {
  if (!c?.key) return false;
  if (c.key === "month") return false;
  if (String(c.format ?? "").toLowerCase() === "month_short") return false;
  return true;
}

describe("statutory certificate templates must bind canonical payroll sources", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  // We evaluate only bodies that look like a certificate template body:
  // schema_version + code + document (v3 shape). This mirrors the
  // runtime `isV3EngineTemplate` gate.
  const templateBodies: Array<{ file: string; body: any }> = [];
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const body of extractJsonBodies(sql)) {
      const b: any = body;
      if (b && Number(b.schema_version) >= 3 && typeof b.code === "string" && Array.isArray(b.document)) {
        templateBodies.push({ file: f, body: b });
      }
    }
  }

  it("finds at least one v3 certificate template body across migrations", () => {
    expect(templateBodies.length).toBeGreaterThan(0);
  });

  it.each(templateBodies)("$body.code (from $file): every matrix data column is bound", ({ body }) => {
    const matrices: MatrixNode[] = [];
    (body.document as any[]).forEach((n) => walkMatrices(n, matrices));
    for (const m of matrices) {
      const cols = (m.columns ?? []).filter(isDataColumn);
      if (cols.length === 0) continue;
      const explicitCodes = Array.isArray(m.rule_codes) ? m.rule_codes.filter(Boolean) : [];
      const sourceKeys = cols.map((c) => c.source_key ?? "").filter(Boolean);
      const derivedKeys = new Set((m.derived_columns ?? []).map((d) => d.key));

      // Contract 1: matrix must resolve to a non-empty rule-code set
      // (otherwise `payroll_employee_monthly_breakdown` is never called
      // and every raw column seeds to 0).
      expect(
        explicitCodes.length + sourceKeys.length,
        `Template ${body.code} matrix has no rule_codes and no source_key on any column — the resolver will never fetch payroll data.`,
      ).toBeGreaterThan(0);

      // Contract 2: every data column must be bound to a canonical
      // source (source_key) or produced by a derived expression.
      const unbound = cols
        .filter((c) => !c.source_key && !derivedKeys.has(String(c.key)))
        .map((c) => c.key);
      expect(
        unbound,
        `Template ${body.code} has matrix data column(s) with no source_key and no derived_columns entry: ${unbound.join(", ")}. Unbound columns silently render as zero on a filed statutory document.`,
      ).toEqual([]);
    }
  });
});
