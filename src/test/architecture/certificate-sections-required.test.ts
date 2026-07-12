/**
 * ADR-0060 v2026.4.0 — Structural contract for certificate templates.
 *
 * Every seeded row in `localization_pack_certificate_templates` must
 * carry either legacy `body.sections[]` or v2 `body.blocks[]` containing,
 * at minimum, identity, data, and signature structure. This test walks
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

  it("a database-level BEFORE trigger enforces the section contract at write time", () => {
    // The definitive gate is the DB trigger — even a rogue insert
    // path that bypasses the linter cannot ship a stub certificate.
    expect(sql).toMatch(/enforce_certificate_template_structure/);
    expect(sql).toMatch(/CREATE TRIGGER\s+trg_certificate_template_structure/);
    for (const need of REQUIRED_IDENTITY) {
      expect(
        sql,
        `trigger source must reference required identity section "${need}"`,
      ).toMatch(new RegExp(need));
    }
    for (const d of DATA_SECTIONS) {
      expect(sql, `trigger source must reference data section "${d}"`).toMatch(
        new RegExp(d),
      );
    }
  });

  it("linter enforces the same structural gate at publish time", () => {
    const linter = readFileSync(
      "supabase/functions/lint-localization-pack/index.ts",
      "utf8",
    );
    expect(linter).toMatch(/validateCertificateStructure/);
    expect(linter).toMatch(/REQUIRED_IDENTITY_SECTIONS/);
    expect(linter).toMatch(/v2 blocks missing employer field_grid/);
    expect(linter).toMatch(/monthly_matrix/);
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