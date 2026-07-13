/**
 * Architecture guard — pack-declared export registry.
 *
 * Locks in the ADR: statutory-return runs must emit a canonical `artifacts[]`
 * list; the UI and hook read it (falling back to the legacy scalar columns
 * only for pre-migration history); and the generator must populate it
 * alongside the legacy columns while both shapes coexist.
 *
 * These are code-shape assertions (grep-level), not runtime tests, so they
 * run in the same test tier as the other architecture guards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, "../../../", rel), "utf8");

describe("statutory return artifacts registry", () => {
  it("generator populates the canonical artifacts list on insert", () => {
    const src = read("supabase/functions/generate-statutory-return/index.ts");
    // Every writer branch must push into the artifacts array so nothing is
    // silently dropped from the pack-declared exports.
    expect(src).toMatch(/pushArtifact\(\{[^}]*format:\s*["']csv["']/);
    expect(src).toMatch(/pushArtifact\(\{[^}]*format:\s*["']pdf["']/);
    expect(src).toMatch(/pushArtifact\(\{[^}]*format:\s*emittedGovFormat/);
    // The insert must carry `artifacts` — not just the legacy scalar columns.
    expect(src).toMatch(/\.insert\(\{[\s\S]{0,2000}artifacts,/);
    // Both select statements must project `artifacts` back to the caller.
    const selects = src.match(/\.select\("[^"]*artifacts[^"]*"\)/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it("hook types the artifacts column and normalises artifact paths", () => {
    const src = read("src/hooks/payroll/useStatutoryReturns.ts");
    expect(src).toMatch(/artifacts:\s*Array<\{/);
    expect(src).toMatch(/artifacts:\s*Array\.isArray\(\(run as any\)\.artifacts\)/);
  });

  it("UI renders one download button per artifact (no hardcoded CSV/PDF branch)", () => {
    const src = read("src/components/payroll/ReturnsTab.tsx");
    // The artifact-driven loop must exist…
    expect(src).toMatch(/arts\.map\(\(a\)/);
    // Legacy scalars were dropped 2026-07-12 — the UI must not mention them.
    expect(src).not.toMatch(/r\.csv_path/);
    expect(src).not.toMatch(/r\.pdf_path/);
    expect(src).not.toMatch(/r\.gov_file_path/);
    expect(src).not.toMatch(/legacyFallback/);
  });
});

describe("format_registry integrity", () => {
  it("renderer contract & registry symbols line up", () => {
    // Cheap smoke test — every writer the migration registers must exist as
    // an actual writer symbol in the shared code path.
    const gov = read("supabase/functions/_shared/govFileWriter.ts");
    for (const w of ["gov_csv", "gov_xlsx", "gov_xml"]) {
      expect(gov).toContain(`"${w}"`);
    }
  });
});

describe("legacy certificate renderers are retired", () => {
  // The v1/v2 pdf-lib certificate renderers were deleted 2026-07-13 and
  // the DB validator now rejects any template with schema_version < 3.
  // This guard fails if any of those files re-appear on disk, or if the
  // edge function grows a new pdf-lib call site for certificates.
  const forbiddenFiles = [
    "src/features/localization/lib/pdf/certificateRenderer.ts",
    "src/features/localization/lib/pdf/certificateRenderer.dispatch.ts",
    "src/features/localization/lib/pdf/certificateRendererV2.ts",
    "supabase/functions/_shared/pdf/certificateRenderer.ts",
    "supabase/functions/_shared/pdf/certificateRendererV2.ts",
    "supabase/functions/_shared/xlsx/certificateXlsxRenderer.ts",
  ];
  it("none of the retired renderer files exist on disk", () => {
    for (const rel of forbiddenFiles) {
      let missing = false;
      try { readFileSync(resolve(__dirname, "../../../", rel), "utf8"); }
      catch { missing = true; }
      expect(missing, `${rel} must stay deleted`).toBe(true);
    }
  });
  it("generate-tax-certificate no longer imports pdf-lib certificate renderers", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).not.toMatch(/renderCertificatePdf\b/);
    expect(src).not.toMatch(/renderCertificateXlsx\b/);
    expect(src).not.toMatch(/pdf\/certificateRenderer/);
  });
});
