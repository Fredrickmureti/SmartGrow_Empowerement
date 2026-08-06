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

describe("document workspace — activity is sourced, not synthesised", () => {
  it("no Sales view builder hand-builds an activity list", () => {
    const offenders = RECORD_SURFACES.filter((f) =>
      /\n\s*activity:\s/.test(read(f)),
    );
    expect(
      offenders,
      "Set `documentId` and let the audit-backed feed load; use `activityExtra` for non-audited milestones",
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

  it("both grids derive layout from one measurement engine", () => {
    const engine = read("src/design-system/records/adaptiveColumns.ts");
    expect(engine).toContain("ResizeObserver");

    for (const grid of [
      "src/design-system/records/LineItemsGrid.tsx",
      "src/design-system/records/EditableLineItemsGrid.tsx",
    ]) {
      const src = read(grid);
      expect(src, `${grid} must use the shared engine`).toContain(
        "useAdaptiveLayout",
      );
      // The only remaining floor is the last-resort scroll fallback, and it
      // is conditional on a measurement — never applied unconditionally.
      expect(src).not.toMatch(/className=\{?"[^"]*min-w-\[\d{3,}px\]/);
    }
  });

  it("document create/edit forms use the editable grid, not a hand-rolled table", () => {
    const FORMS = SALES_FILES.filter((f) => /(CreatePage|EditPage)\.tsx$/.test(f));
    const migrated = FORMS.filter((f) =>
      /EditableLineItemsGrid/.test(read(f)),
    );
    // Phase 8 migrates document forms module by module; every migrated form
    // must be free of the legacy <Table> line editor and its width floor.
    for (const f of migrated) {
      const src = read(f);
      expect(src, `${f} still ships the legacy line table`).not.toMatch(
        /<TableHead\b/,
      );
      expect(src, `${f} still forces a horizontal floor`).not.toMatch(
        /min-w-\[\d{3,}px\]/,
      );
    }
    expect(migrated.length, "no form is on the editable grid yet").toBeGreaterThan(0);
  });
});
