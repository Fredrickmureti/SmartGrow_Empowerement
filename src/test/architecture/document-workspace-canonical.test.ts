/**
 * Architecture ratchet — the canonical document workspace.
 *
 * The Sales document workspace was consolidated onto one descriptor
 * (`DocumentRecordView`) with two projections (`RecordScaffold` for the
 * object page, `PeekScaffold` for the drawer). These guards keep it that
 * way. Each one froze out a specific regression found during the audit:
 *
 *  1. Per-file status maps — the same invoice read "Partial" in one surface
 *     and "Partially paid" in another. Status vocabulary lives in
 *     `documentStatus.tsx` only.
 *  2. Hand-rolled shells — record pages that composed RecordShell /
 *     DetailSheet directly drifted from the scaffold within one release.
 *  3. Hard minimum widths on line-item grids — the cause of horizontal
 *     scrolling inside the peek drawer regardless of column count.
 *  4. Duplicate line-item renderers — `LineItemsGrid` is the only one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const SALES_FILES = walk("src/features/sales");
const RECORD_SURFACES = SALES_FILES.filter((f) =>
  /(RecordPage|PeekSheet|View)\.tsx$/.test(f),
);

const read = (f: string) => readFileSync(f, "utf8");

describe("document workspace — one status vocabulary", () => {
  it("no Sales record surface declares its own status tone or label map", () => {
    const offenders = RECORD_SURFACES.filter((f) =>
      /(STATUS_TONE|STATUS_LABEL|const TONE\b|const LABEL\b)/.test(read(f)),
    );
    expect(
      offenders,
      "Use documentStatus.tsx (kind + raw status) instead of a local map",
    ).toEqual([]);
  });
});

describe("document workspace — two projections, one descriptor", () => {
  it("Sales record pages and peeks compose the shared scaffolds", () => {
    const offenders = RECORD_SURFACES.filter((f) => {
      const src = read(f);
      const handRolled =
        /<RecordShell\b/.test(src) || /<DetailSheet\b/.test(src);
      return handRolled;
    });
    expect(
      offenders,
      "Compose RecordScaffold / PeekScaffold — do not hand-roll the shell",
    ).toEqual([]);
  });
});

describe("document workspace — line items adapt to their container", () => {
  it("LineItemsGrid is the only line-item renderer", () => {
    const offenders = SALES_FILES.filter(
      (f) => /\bLineItemsTable\b|\bLineItemTable\b/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("no surface forces a horizontal floor on the grid", () => {
    const offenders = [...RECORD_SURFACES, ...walk("src/design-system/records")]
      .filter((f) => !f.endsWith("LineItemsGrid.tsx"))
      .filter((f) => /min-w-\[\d{3,}px\]/.test(read(f)));
    expect(
      offenders,
      "Width is a container concern; declare column minWidth/priority instead",
    ).toEqual([]);
  });

  it("the grid derives its layout from measurement, not a fixed floor", () => {
    const src = read("src/design-system/records/LineItemsGrid.tsx");
    expect(src).toContain("ResizeObserver");
    // The only remaining floor is the last-resort scroll fallback, and it is
    // conditional on a measurement — never applied unconditionally.
    expect(src).toContain("needsScroll");
    expect(src).not.toMatch(/className=\{?"[^"]*min-w-\[\d{3,}px\]/);
  });
});
