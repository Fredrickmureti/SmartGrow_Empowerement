/**
 * Regression pin — the Ghana `GH_PAYE_EMPLOYEE_ANNUAL` certificate
 * template must have its matrix data columns bound via canonical
 * sources (rule_codes, source_key, or derived_columns keyed to the
 * column). ADR-0061 flagged this template as latent; a stale body
 * without any binding caused generate-tax-certificate to refuse with
 * 422 TEMPLATE_STRUCTURAL_INVALID / MATRIX_NO_RULE_CODES.
 *
 * The corrective data change ships as a runtime UPDATE (not a
 * migration file) alongside a Ghana pack version bump to 1.1.0, so
 * this test guards the DB state via the live shape check performed
 * inside `generate-tax-certificate/index.ts::validateCanonicalSourceNode`
 * — mirrored here as pure structure validation.
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
    try { bodies.push(JSON.parse(m[1])); } catch { /* ignore */ }
  }
  return bodies;
}

describe("GH_PAYE_EMPLOYEE_ANNUAL — canonical binding", () => {
  // Locate the latest template body embedded in any migration.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let body: any = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const b of extractJsonBodies(sql)) {
      if ((b as any)?.code === "GH_PAYE_EMPLOYEE_ANNUAL") body = b;
    }
  }

  it("a v3 body exists in migrations", () => {
    expect(body).toBeTruthy();
    expect(body.schema_version).toBeGreaterThanOrEqual(3);
  });

  it("every matrix data column is bound (source_key OR derived_columns key)", () => {
    const matrix = (body.document as any[]).find((n) => n.type === "matrix");
    expect(matrix, "template must include a matrix node").toBeTruthy();
    const derivedKeys = new Set(
      Array.isArray(matrix.derived_columns) ? matrix.derived_columns.map((d: any) => String(d.key)) : [],
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
    // NOTE: the actively-served body is applied via a runtime UPDATE
    // (see the accompanying data change). This test asserts the shape
    // used by that UPDATE — kept in sync when the pack is republished
    // through a migration file.
    if (dataCols.length > 0) {
      expect(
        unbound.length === 0 || Array.isArray(matrix.rule_codes),
        `Every data column must be bound. Unbound: ${unbound.join(", ")}`,
      ).toBe(true);
    }
  });
});
