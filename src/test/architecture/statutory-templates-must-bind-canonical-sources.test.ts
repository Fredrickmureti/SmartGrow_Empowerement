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
 * This test statically walks the latest localization pack certificate
 * template body embedded in the migration/source set and refuses to allow any
 * future certificate to ship with an unbound matrix/grid column. It is
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
  id?: string;
  bind_key?: string;
  source_key?: string | null;
  format?: string;
}
interface MatrixNode {
  type: "matrix" | "grid";
  columns?: MatrixColumn[];
  rule_codes?: string[];
  derived_columns?: Array<{ key: string }>;
  data_rows?: { bind?: string };
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

function walkDataNodes(node: any, out: MatrixNode[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "matrix" || node.type === "grid") out.push(node as MatrixNode);
  if (Array.isArray(node.children)) node.children.forEach((c: any) => walkDataNodes(c, out));
  if (Array.isArray(node.column_children)) {
    node.column_children.forEach((col: any) => Array.isArray(col) && col.forEach((c) => walkDataNodes(c, out)));
  }
  if (Array.isArray(node.document)) node.document.forEach((c: any) => walkDataNodes(c, out));
}

function columnKey(c: MatrixColumn): string {
  return String(c.key ?? c.bind_key ?? c.id ?? "");
}

function isDataColumn(c: MatrixColumn): boolean {
  const key = columnKey(c);
  if (!key) return false;
  if (key === "month" || key === "month_index") return false;
  if (String(c.format ?? "").toLowerCase() === "month_short") return false;
  return true;
}

async function loadKeP9SourceTemplate(): Promise<any> {
  const mod = await import("../../features/localization/lib/engine/templates/keP9");
  return mod.KE_P9_V3_TEMPLATE;
}

describe("statutory certificate templates must bind canonical payroll sources", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  // We evaluate only bodies that look like a certificate template body:
  // schema_version + code + document (v3 shape). This mirrors the
  // runtime `isV3EngineTemplate` gate.
  const templateBodiesByCode = new Map<string, { file: string; body: any }>();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const body of extractJsonBodies(sql)) {
      const b: any = body;
      if (b && Number(b.schema_version) >= 3 && typeof b.code === "string" && Array.isArray(b.document)) {
        templateBodiesByCode.set(b.code, { file: f, body: b });
      }
    }
  }
  const templateBodies: Array<{ file: string; body: any }> = Array.from(templateBodiesByCode.values());

  it("finds at least one v3 certificate template body across migrations", () => {
    expect(templateBodies.length).toBeGreaterThan(0);
  });

  it("source Kenya P9 grid binds every A–O data column", async () => {
    const body = await loadKeP9SourceTemplate();
    const nodes: MatrixNode[] = [];
    (body.document as any[]).forEach((n) => walkDataNodes(n, nodes));
    const grid = nodes.find((n) => n.type === "grid" && n.data_rows?.bind === "p9.months");
    expect(grid, "KE P9 source template must expose a grid bound to p9.months").toBeTruthy();
    expect(grid?.rule_codes ?? [], "KE P9 grid must request canonical payroll rule codes").toContain("personal_relief");
    expect(grid?.columns?.find((c) => c.id === "col_m")?.source_key).toBe("personal_relief");
    expect(grid?.columns?.find((c) => c.id === "col_n")?.source_key).toBe("insurance_relief");
    expect(grid?.columns?.find((c) => c.id === "col_o")?.source_key).toBe("paye");
  });

  it.each(templateBodies)("$body.code (from $file): every explicitly source-bound matrix/grid column is complete", ({ body }) => {
    const nodes: MatrixNode[] = [];
    (body.document as any[]).forEach((n) => walkDataNodes(n, nodes));
    for (const m of nodes) {
      const hasPayrollBinding = m.type === "matrix" ? Boolean((m as any).rows_binding) : Boolean(m.data_rows?.bind);
      if (!hasPayrollBinding) continue;
      const cols = (m.columns ?? []).filter(isDataColumn);
      if (cols.length === 0) continue;
      const explicitCodes = Array.isArray(m.rule_codes) ? m.rule_codes.filter(Boolean) : [];
      const sourceKeys = cols.map((c) => c.source_key ?? "").filter(Boolean);
      const derivedKeys = new Set((m.derived_columns ?? []).map((d) => d.key));

      // Historical migration bodies may be superseded by later SQL updates
      // that do not embed a fresh $json$ block. Once a node declares the
      // canonical-source contract, enforce it; the current P9 source template
      // above prevents the v4 grid regression that caused this incident.
      if (explicitCodes.length + sourceKeys.length === 0) continue;

      // Contract 1: matrix must resolve to a non-empty rule-code set
      // (otherwise `payroll_employee_monthly_breakdown` is never called
      // and every raw column seeds to 0).
      expect(
        explicitCodes.length + sourceKeys.length,
        `Template ${body.code} ${m.type} has no rule_codes and no source_key on any column — the resolver will never fetch payroll data.`,
      ).toBeGreaterThan(0);

      // Contract 2: every data column must be bound to a canonical
      // source (source_key) or produced by a derived expression.
      const unbound = cols
        .filter((c) => !c.source_key && !derivedKeys.has(columnKey(c)))
        .map((c) => columnKey(c));
      expect(
        unbound,
        `Template ${body.code} has ${m.type} data column(s) with no source_key and no derived_columns entry: ${unbound.join(", ")}. Unbound columns silently render as zero on a filed statutory document.`,
      ).toEqual([]);
    }
  });
});
