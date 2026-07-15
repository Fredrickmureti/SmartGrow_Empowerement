/**
 * Architecture guard — every string arg in every derived_columns
 * expression on a v3 certificate template matrix/grid must resolve to
 * a real symbol available on the matrix row at derivation time:
 *
 *   1) another column's `key` / `bind_key` / `id`, OR
 *   2) an earlier `derived_columns[j].key` (j < i), OR
 *   3) a raw rule_code exposed on the matrix (`rule_codes[]` or any
 *      column's `source_key`).
 *
 * Numeric literal args are always allowed.
 *
 * The pivot's `argValue()` treats unknown symbols as 0, so a typo in a
 * derived expression silently zeroes the affected column on a filed
 * statutory document. ADR-0061 already refuses unbound data columns;
 * this guard closes the sibling gap that caused the KE P9A regression
 * where `derived_columns` referenced `col_a…col_o` shorthand that
 * never existed as row keys, zeroing Gross Pay, Pension caps, Total
 * Deductions, Chargeable Pay and Tax Charged.
 *
 * Country-agnostic: applies to every v3 certificate template body
 * embedded in the migration set, present and future.
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
interface DerivedColumn {
  key: string;
  args?: Array<string | number>;
}
interface MatrixNode {
  type: "matrix" | "grid";
  columns?: MatrixColumn[];
  rule_codes?: string[];
  derived_columns?: DerivedColumn[];
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

interface Offence {
  template_code: string;
  file: string;
  node_type: string;
  derived_key: string;
  arg: string;
  index: number;
}

describe("matrix derived_columns args must resolve to real row symbols", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
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
  const templateBodies = Array.from(templateBodiesByCode.values());

  it.each(templateBodies)(
    "$body.code (from $file): every derived_columns arg resolves",
    ({ body, file }) => {
      const nodes: MatrixNode[] = [];
      (body.document as any[]).forEach((n) => walkDataNodes(n, nodes));

      const offences: Offence[] = [];
      for (const m of nodes) {
        const derived = Array.isArray(m.derived_columns) ? m.derived_columns : [];
        if (derived.length === 0) continue;

        const columnKeys = new Set<string>();
        for (const c of m.columns ?? []) {
          const t = columnKey(c);
          if (t) columnKeys.add(t);
        }
        const ruleCodes = new Set<string>();
        for (const rc of m.rule_codes ?? []) if (rc) ruleCodes.add(String(rc));
        for (const c of m.columns ?? []) {
          if (c.source_key) ruleCodes.add(String(c.source_key));
        }

        const derivedKeysSoFar = new Set<string>();
        derived.forEach((d, idx) => {
          for (const a of d.args ?? []) {
            if (typeof a === "number") continue;
            const s = String(a);
            if (columnKeys.has(s) || derivedKeysSoFar.has(s) || ruleCodes.has(s)) continue;
            offences.push({
              template_code: body.code,
              file,
              node_type: m.type,
              derived_key: String(d.key ?? `#${idx}`),
              arg: s,
              index: idx,
            });
          }
          if (d.key) derivedKeysSoFar.add(String(d.key));
        });
      }

      expect(
        offences,
        `Template ${body.code} has derived_columns args that do not resolve to any column key, earlier derived key, or rule_code. ` +
          `Unknown symbols silently evaluate to 0 in the pivot. Fix the pack, do not patch the platform. Offences: ${JSON.stringify(offences)}`,
      ).toEqual([]);
    },
  );

  it("finds at least one v3 certificate template body across migrations", () => {
    expect(templateBodies.length).toBeGreaterThan(0);
  });
});
