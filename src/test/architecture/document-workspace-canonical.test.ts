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
const DOCUMENT_FILES = [
  ...SALES_FILES,
  ...walk("src/features/purchases"),
  ...walk("src/features/finance"),
  ...walk("src/components/inventory"),
];
const RECORD_SURFACES = SALES_FILES.filter((f) =>
  /(RecordPage|PeekSheet|View)\.tsx$/.test(f),
);
const ALL_RECORD_SURFACES = DOCUMENT_FILES.filter((f) =>
  /(RecordPage|PeekSheet)\.tsx$/.test(f),
);

/**
 * `WarehouseStockPeekSheet` is an editable stock browser, not a business
 * document: it has no descriptor, status ladder or totals. It stays on
 * `DetailSheet` by decision, so it is the one exemption from the shell guard.
 */
const SHELL_EXEMPT = /WarehouseStockPeekSheet\.tsx$/;

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
    const FORMS = DOCUMENT_FILES.filter((f) =>
      /(CreatePage|EditPage|Form)\.tsx$/.test(f),
    );

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

  /**
   * Phase 11 — close the gap the migration guard left open: it only checked
   * forms that had *already* moved. A brand-new create page with an inline
   * `grid-cols-12` line editor would have passed CI.
   *
   * `BudgetEditPage` is exempt by decision: its table is an account × month
   * budget-vs-actual matrix, not a transactional line editor.
   */
  it("no document form hand-rolls a line editor", () => {
    const FORM_EXEMPT = /budgets\/BudgetEditPage\.tsx$/;
    const offenders = DOCUMENT_FILES.filter((f) =>
      /(CreatePage|EditPage|Form)\.tsx$/.test(f),
    )
      .filter((f) => !FORM_EXEMPT.test(f))
      .filter((f) => {
        const src = read(f);
        if (/EditableLineItemsGrid/.test(src)) return false;
        return /grid-cols-12|<TableHead\b/.test(src);
      });
    expect(
      offenders,
      "Compose EditableLineItemsGrid — do not hand-roll a line grid or table",
    ).toEqual([]);
  });
});

describe("document workspace — one lifecycle renderer", () => {
  const STRIPS = [
    "src/design-system/records/DocumentLifecycleStrip.tsx",
    "src/design-system/records/DocumentSettlementStrip.tsx",
  ];

  it("lineage RPCs are called only by the shared strips", () => {
    const offenders = [...DOCUMENT_FILES, ...walk("src/design-system/records")]
      .filter((f) => !STRIPS.includes(f))
      .filter((f) => /get_document_(settlement_)?lineage/.test(read(f)));
    expect(
      offenders,
      "Render DocumentLifecycleStrip / DocumentSettlementStrip instead of querying lineage per feature",
    ).toEqual([]);
  });

  it("the settlement half of the chain is rendered", () => {
    const strip = read("src/design-system/records/DocumentSettlementStrip.tsx");
    for (const step of [
      "payment",
      "journal_entry",
      "reconciliation",
      "credit_note",
      "sales_return",
      "collections",
    ]) {
      expect(strip, `settlement step ${step} is missing`).toContain(step);
    }
    // Both halves must be composed by the workspace, not by a feature page.
    const workspace = read("src/design-system/records/DocumentWorkspace.tsx");
    expect(workspace).toContain("DocumentLifecycleStrip");
    expect(workspace).toContain("DocumentSettlementStrip");
  });
});


describe("document workspace — the layer covers Purchases, Finance and Inventory", () => {
  it("every record page and peek composes the shared scaffolds", () => {
    const offenders = ALL_RECORD_SURFACES.filter((f) => !SHELL_EXEMPT.test(f)).filter(
      (f) => /<RecordShell\b|<DetailSheet\b/.test(read(f)),
    );
    expect(
      offenders,
      "Compose RecordScaffold / PeekScaffold — do not hand-roll a second peek",
    ).toEqual([]);
  });

  it("no record surface declares its own status tone or label map", () => {
    const offenders = ALL_RECORD_SURFACES.filter((f) =>
      /(STATUS_TONE|STATUS_LABEL|const TONE\b|const LABEL\b)/.test(read(f)),
    );
    expect(offenders, "Status vocabulary lives in documentStatus.tsx").toEqual([]);
  });

  /**
   * The reported bug: the invoice full page offered 4 actions while its row
   * menu offered 14, and Edit was permanently disabled. A document record
   * page must therefore feed `RecordScaffold` the shared `actions` array —
   * never a hand-rolled header cluster, which is how the two drifted.
   * `customer` is a master record, not a transactional document.
   */
  const HEADER_CLUSTER_EXEMPT = /CustomerRecordPage\.tsx$/;

  it("document record pages render the shared actions bar, not a hand-rolled cluster", () => {
    const offenders = ALL_RECORD_SURFACES.filter((f) => /RecordPage\.tsx$/.test(f))
      .filter((f) => !HEADER_CLUSTER_EXEMPT.test(f))
      .filter((f) => /headerActions=/.test(read(f)));
    expect(
      offenders,
      "Pass `actions={[…]}` from the document's use<Doc>Actions hook instead of headerActions",
    ).toEqual([]);
  });

  it("Sales and Purchases carry no type suppressions", () => {
    const offenders = [
      ...SALES_FILES,
      ...walk("src/features/purchases"),
    ].filter((f) => /@ts-nocheck/.test(read(f)));
    expect(
      offenders,
      "A suppressed file is not migrated — fix the types instead",
    ).toEqual([]);
  });
});

/**
 * 5. Purchases list pages that hand-rolled their own row menus. Bills and
 *    Purchase Orders each grew a local DropdownMenu whose items diverged
 *    from the record page: "Post to Ledger" and the approval lifecycle
 *    existed only in the list, "Preview" only on the page, and "Download
 *    PDF" nowhere. A purchases list must render the document's actions hook
 *    through `DocumentActionsMenu`, never its own DropdownMenuItems.
 */
describe("purchases documents — one action vocabulary", () => {
  const LIST_PAGES = [
    "src/pages/Bills.tsx",
    "src/pages/PurchaseOrders.tsx",
  ];

  it("purchases list pages do not hand-roll row action menus", () => {
    const offenders = LIST_PAGES.filter((f) => /DropdownMenuItem/.test(read(f)));
    expect(
      offenders,
      "Row actions must come from use<Doc>Actions via DocumentActionsMenu",
    ).toEqual([]);
  });

  const ACTION_HOOKS = walk("src/features/purchases").filter((f) =>
    /use[A-Za-z]+Actions\.tsx$/.test(f),
  );

  it("every purchases actions hook offers the full output vocabulary", () => {
    // No exclusions: every purchases document — vendor credit notes included —
    // has a registered document kind and snapshot builder, so all three output
    // verbs must be present.
    const missing = ACTION_HOOKS.filter((f) => {

      const src = read(f);
      return !(
        /id: "preview"/.test(src) &&
        /id: "print"/.test(src) &&
        /id: "download"/.test(src)
      );
    });
    expect(
      missing,
      "Preview, Print and Download are three distinct verbs; each purchases document must offer all three",
    ).toEqual([]);
  });
});
