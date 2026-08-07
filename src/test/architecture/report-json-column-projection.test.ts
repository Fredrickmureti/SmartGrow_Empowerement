/**
 * Architecture guard — the report RESULT owns its column projection.
 *
 * The defect this guards against: `render-report`'s JSON branch used to
 * return the raw builder result (`{ data, summary }`) verbatim. No builder
 * attaches a `columns` key, so the screen received rows with no column
 * spec, rendered zero headers and zero cells, and displayed nothing but a
 * "Rows: N" metadata band — while the PDF of the identical result was
 * correct because `renderReport()` resolved columns from the registry.
 *
 * Invariants:
 *  1. Column resolution lives in ONE module (`_shared/reports/resolveColumns.ts`).
 *  2. Both the JSON branch and the PDF renderer go through it.
 *  3. Every reportType a server builder handles has a registry column spec,
 *     so no future report can ship a headerless screen/CSV/XLSX.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FN = join(process.cwd(), "supabase", "functions");
const indexSrc = readFileSync(join(FN, "render-report", "index.ts"), "utf8");
const renderSrc = readFileSync(join(FN, "_shared", "reports", "renderReport.ts"), "utf8");
const specSrc = readFileSync(join(FN, "_shared", "reports", "columnSpecs.ts"), "utf8");
const resolveSrc = readFileSync(join(FN, "_shared", "reports", "resolveColumns.ts"), "utf8");

function specKeys(): Set<string> {
  const keys = new Set<string>();
  for (const m of specSrc.matchAll(/^ {2}([a-z0-9_]+):\s*\{/gm)) keys.add(m[1]!);
  for (const m of specSrc.matchAll(/REPORT_SPECS\["([a-z0-9_]+)"\]/g)) keys.add(m[1]!);
  return keys;
}

/** Report keys enumerated in the `[... ] as const` builder dispatch lists. */
function builderKeys(): string[] {
  const out: string[] = [];
  for (const m of indexSrc.matchAll(/\[\s*((?:\s*"[a-z_0-9]+",?\s*)+)\]\s*as const/g)) {
    for (const k of m[1]!.match(/"[a-z_0-9]+"/g) ?? []) out.push(k.slice(1, -1));
  }
  return out;
}

describe("architecture: report column projection", () => {
  it("resolveColumns.ts is the only definition of inferColumns", () => {
    expect(resolveSrc).toMatch(/export function inferColumns/);
    expect(renderSrc).not.toMatch(/function inferColumns/);
    expect(indexSrc).not.toMatch(/function inferColumns/);
  });

  it("renderReport resolves columns through the shared resolver", () => {
    expect(renderSrc).toMatch(/resolveReportColumns\(/);
    // No private precedence chain left behind.
    expect(renderSrc).not.toMatch(/options\.columns\s*\?\?\s*spec\?\.columns/);
  });

  it("the JSON branch attaches a resolved columns array", () => {
    const json = indexSrc.slice(indexSrc.indexOf('if (format === "json")'));
    expect(json).toMatch(/resolveReportColumns\(/);
    expect(json.slice(0, 1200)).toMatch(/\bcolumns,/);
  });

  it("prebuilt CSV/XLSX/PDF exports also go through the resolver", () => {
    expect(indexSrc).toMatch(/const effectiveColumns = resolveReportColumns\(/);
    expect(indexSrc).toMatch(/columns: effectiveColumns/);
  });

  it("every server-built reportType has a registry column spec", () => {
    const specs = specKeys();
    const keys = builderKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((k) => !specs.has(k))).toEqual([]);
  });

  it("no registry spec declares an empty column list", () => {
    const empty = [...specSrc.matchAll(/^ {2}([a-z0-9_]+):\s*\{[\s\S]{0,400}?columns:\s*\[\s*\]/gm)].map(
      (m) => m[1],
    );
    expect(empty).toEqual([]);
  });
});
