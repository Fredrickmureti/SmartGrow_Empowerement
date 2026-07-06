/**
 * ADR-0060 v2026.4.0 — Structural contract for certificate templates.
 *
 * Every seeded row in `localization_pack_certificate_templates` must
 * carry a `body.sections[]` array containing, at minimum, the identity
 * headers, one data section, and a signature block. This test walks
 * every migration and asserts that the *final* seeded shape of each
 * `code` complies — regressions here would let a pack ship the
 * legacy "P9A Low Income" stub that fell back to the generic
 * renderer.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_IDENTITY = ["employer_header", "employee_header", "signature_block"];
const DATA_SECTIONS = ["monthly_breakdown", "ytd_table", "totals"];

function loadMigrations(): string {
  const dir = "supabase/migrations";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n\n-- FILE BOUNDARY --\n\n");
}

describe("certificate-sections-required", () => {
  const sql = loadMigrations();

  it("no seed writes an empty body.sections array to a certificate template", () => {
    // Look for INSERT/UPDATE writes to the cert templates table whose
    // body has an empty sections array.
    const emptyPattern = /localization_pack_certificate_templates[\s\S]{0,4000}?jsonb_build_array\(\s*\)/g;
    const hits = sql.match(emptyPattern) ?? [];
    // Filter: only flag hits where the empty array is inside a
    // `'sections'` key. This is coarse-grained but sufficient — the
    // final state check below is the real assertion.
    const bad = hits.filter((h) => /'sections'\s*,\s*jsonb_build_array\(\s*\)/.test(h));
    expect(bad, "found a seed that writes empty sections to a cert template").toHaveLength(0);
  });

  it("every distinct cert-template code seeded in the KE pack has all required section types in its latest body", () => {
    // We can't execute SQL from the test runner, so scan the latest
    // migration that writes each `code = '…'` and confirm its body
    // literal contains every required section type as an
    // 'type','X' pair.
    const codeLatest = new Map<string, string>();
    const upserts = sql.matchAll(
      /(UPDATE|INSERT INTO)\s+public\.localization_pack_certificate_templates([\s\S]{0,8000}?)WHERE[\s\S]{0,200}?code\s*=\s*'([A-Z0-9_]+)'|(?:code[^,]*)?\s*'([A-Z0-9_]+)'[\s\S]{0,20}?body[\s\S]{0,8000}/g,
    );
    // Simpler approach: grep for each cert-template block containing a
    // `body = jsonb_build_object(...)` and note the WHERE code.
    const blockRe =
      /public\.localization_pack_certificate_templates[\s\S]{0,10000}?body\s*=\s*jsonb_build_object\(([\s\S]*?)\)\s*\)\s*WHERE[\s\S]{0,200}?code\s*=\s*'([A-Z0-9_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(sql)) !== null) {
      const body = m[1];
      const code = m[2];
      codeLatest.set(code, body); // later matches overwrite earlier ones → "latest wins"
    }
    expect(codeLatest.size, "no cert template UPDATE blocks found in migrations").toBeGreaterThan(0);

    for (const [code, body] of codeLatest) {
      const types = Array.from(body.matchAll(/'type'\s*,\s*'([a-z_]+)'/g)).map((x) => x[1]);
      for (const need of REQUIRED_IDENTITY) {
        expect(types, `KE cert template ${code} missing required section "${need}"`).toContain(
          need,
        );
      }
      const hasData = DATA_SECTIONS.some((d) => types.includes(d));
      expect(hasData, `KE cert template ${code} has no data section`).toBe(true);
    }
  });

  it("linter enforces the same structural gate at publish time", () => {
    const linter = readFileSync(
      "supabase/functions/lint-localization-pack/index.ts",
      "utf8",
    );
    expect(linter).toMatch(/validateTemplateStructure/);
    expect(linter).toMatch(/REQUIRED_IDENTITY_SECTIONS/);
    expect(linter).toMatch(/legacy blocks-only templates are no longer publishable/);
  });

  it("generate-tax-certificate refuses to render structurally invalid templates", () => {
    const fn = readFileSync(
      "supabase/functions/generate-tax-certificate/index.ts",
      "utf8",
    );
    expect(fn).toMatch(/TEMPLATE_STRUCTURAL_INVALID/);
    // Legacy baseSummary fallback must be gone.
    expect(fn).not.toMatch(/const baseSummary/);
  });
});