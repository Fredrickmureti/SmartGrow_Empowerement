/**
 * Source-inspection guard for the four cycle-count artifacts (ADR 0106).
 *
 * Locks three things that have each regressed elsewhere in the printing
 * platform before:
 *
 * 1. Every count document type is registered in `FETCHER_MAP`, so
 *    `generate-document` can resolve it.
 * 2. `count_sheet_blind` has its OWN fetcher and that fetcher never reads
 *    `system_qty` / `variance_qty`. A blind sheet must be structurally
 *    incapable of carrying an expectation — not merely configured not to.
 * 3. Dispatch goes through `printDocument` from `PrintService`; no page
 *    calls a render endpoint directly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const EDGE = read("supabase/functions/generate-document/index.ts");
const MENU = read("src/features/warehouse/counts/CountDocumentsMenu.tsx");
const REVIEW = read("src/pages/warehouse/CountReview.tsx");
const SESSION = read("src/pages/warehouse/CountSession.tsx");
const MATRIX = read("docs/printing-event-coverage.md");

const TYPES = [
  ["count_sheet", "fetchCountSheet"],
  ["count_sheet_blind", "fetchCountSheetBlind"],
  ["count_variance_report", "fetchCountVarianceReport"],
  ["count_audit_report", "fetchCountAuditReport"],
] as const;

describe("cycle-count document registration", () => {
  for (const [type, fetcher] of TYPES) {
    it(`${type} is wired to ${fetcher} in FETCHER_MAP`, () => {
      expect(EDGE).toContain(`async function ${fetcher}(`);
      expect(EDGE).toMatch(new RegExp(`\\b${type}:\\s*${fetcher},`));
    });

    it(`${type} has a WIRED row in the coverage matrix`, () => {
      const row = MATRIX.split("\n").find((l) => l.includes(`\`${type}\``));
      expect(row, `no matrix row for ${type}`).toBeTruthy();
      expect(row).toContain("WIRED");
    });
  }
});

describe("blind count sheet cannot leak an expected quantity", () => {
  const body = EDGE.slice(
    EDGE.indexOf("async function fetchCountSheetBlind("),
    EDGE.indexOf("async function fetchCountVarianceReport("),
  );

  it("has a dedicated fetcher body", () => {
    expect(body.length).toBeGreaterThan(200);
  });

  for (const forbidden of ["system_qty", "variance_qty", "counted_qty"]) {
    it(`never reads ${forbidden}`, () => {
      expect(body).not.toContain(`l.${forbidden}`);
    });
  }
});

describe("cycle-count print dispatch", () => {
  it("goes through the single client entry point", () => {
    expect(MENU).toContain('from "@/services/printing/PrintService"');
    expect(MENU).toContain("printDocument(");
  });

  it("never invokes a render endpoint from the app tree", () => {
    for (const src of [MENU, REVIEW, SESSION]) {
      expect(src).not.toContain("generate-document");
      expect(src).not.toContain("render-document");
    }
  });

  it("is mounted on both the counting and the review surface", () => {
    expect(SESSION).toContain("<CountDocumentsMenu");
    expect(REVIEW).toContain("<CountDocumentsMenu");
  });

  it("offers the operator only the walk-the-aisle sheet", () => {
    expect(SESSION).toMatch(/only=\{\["count_sheet"\]\}/);
  });
});
