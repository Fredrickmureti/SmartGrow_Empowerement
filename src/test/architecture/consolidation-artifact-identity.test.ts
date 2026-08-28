/**
 * R2b — artifact identity truthfulness.
 *
 * A consolidated artifact must never present a per-render export hash as if it
 * were a consolidation run: two PDFs of the same period printed minutes apart
 * carried two different "Run" numbers while `consolidation_runs` was empty.
 * The hash identifies the rendition (an export reference); the word "run" is
 * reserved for a persisted consolidation run.
 *
 * Until a consolidated statement can be rendered *from* a finalized run, the
 * artifact must say so on its face rather than leaving the reader to assume it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const footerSource = read("supabase/functions/_shared/pdf/components/BrandedFooter.ts");
const generatorSource = read("supabase/functions/_shared/reportPdfGenerator.ts");
const statementsSource = read("src/pages/reports/ConsolidatedStatements.tsx");
const trialBalanceSource = read("src/pages/reports/ConsolidatedTrialBalance.tsx");

describe("PDF footer disclosure", () => {
  it("labels the render hash an export reference, never a run", () => {
    expect(footerSource).toContain("Export ref ${config.disclosure.runHash}");
    // No `Run <hash>` interpolation anywhere in the footer line.
    expect(footerSource).not.toMatch(/`Run \$\{/);
    expect(footerSource).not.toMatch(/push\(`Run /);
  });

  it("documents the same contract on the payload type", () => {
    expect(generatorSource).toContain("Export ref {short-hash}");
    expect(generatorSource).not.toContain("• Run {short-hash}");
  });
});

describe("consolidated artifacts declare their basis", () => {
  for (const [name, source] of [
    ["consolidated statements", statementsSource],
    ["consolidated trial balance", trialBalanceSource],
  ] as const) {
    it(`${name} states the figures are a live calculation, not a finalized run`, () => {
      expect(source).toContain("live calculation, not a finalized consolidation run");
    });
  }
});

describe("group artifacts carry group identity", () => {
  for (const [name, source] of [
    ["consolidated statements", statementsSource],
    ["consolidated trial balance", trialBalanceSource],
  ] as const) {
    it(`${name} issues from the group parent, never the active branch`, () => {
      expect(source).toContain("selectedGroup?.parent_business_id");
      expect(source).toContain("branchId: null");
    });
  }
});
