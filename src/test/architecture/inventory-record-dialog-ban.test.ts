/**
 * Architecture guard — Inventory record create/edit/peek surface.
 *
 * Enterprise UX standard: every create + edit flow for an Inventory
 * business record MUST be a `/new` or `/:id/edit` route composed on top
 * of `RecordFormShell` from `@/design-system`, and every peek surface
 * MUST be a `*PeekSheet.tsx` composed on `PeekScaffold` /
 * `DocumentPeekShell` — never a `Dialog` or bespoke `Drawer`.
 *
 * This test:
 *   1. Freezes the list of legacy Inventory dialog/drawer files still
 *      awaiting migration (the allowlist below). Every entry must be
 *      REMOVED — not appended to — as its route pair / peek sheet lands.
 *   2. Forbids any NEW `Create*Dialog.tsx` / `Edit*Dialog.tsx` /
 *      `*DetailDialog.tsx` / `*DetailDrawer.tsx` file appearing under
 *      the Inventory surface.
 *
 * If a new file makes this test fail, the fix is NOT to add it to the
 * allowlist — the fix is to build the create/edit route on top of
 * `RecordFormShell`, or the peek surface on top of `PeekScaffold`, and
 * delete the dialog/drawer file.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const INVENTORY_GLOBS = [
  "src/components/inventory",
  "src/components/warehouses",
  "src/components/products",
];

/**
 * Legacy dialogs/drawers still awaiting migration to `RecordFormShell`
 * (create/edit) or `PeekScaffold` (detail). As each migration lands,
 * DELETE the file AND remove its entry here. New Inventory record
 * dialogs MAY NOT be added — this list only shrinks.
 */
const LEGACY_DIALOG_ALLOWLIST = new Set<string>([
  // All legacy drawers migrated to *PeekSheet.tsx on DetailSheet/PeekScaffold.
  // AdjustmentDetailDrawer → AdjustmentPeekSheet.
  // WarehouseStockDrawer → WarehouseStockPeekSheet.
  // MovementDetailDrawer → StockMovementPeekSheet.
  // TransferDetailDrawer → StockTransferPeekSheet.
  // SourceDocumentDrawer → SourceDocumentPeekSheet.
  // ReverseAdjustmentDialog is a confirm-style dialog and target says "keep".
]);

function scanRecordSurfaces(): string[] {
  const existing = INVENTORY_GLOBS.filter((g) => existsSync(g));
  if (existing.length === 0) return [];
  const cmd =
    "find " +
    existing.join(" ") +
    " -type f -name '*.tsx' 2>/dev/null || true";
  const all = execSync(cmd, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  return all.filter((p) =>
    /\/(Create|Edit)[A-Za-z0-9]+Dialog\.tsx$|\/[A-Za-z0-9]+Detail(Dialog|Drawer)\.tsx$|\/(SourceDocument|WarehouseStock)Drawer\.tsx$/.test(
      p,
    ),
  );
}

/**
 * Inventory app list/workspace pages must not host substantial record forms in
 * inline Dialogs. Confirmation-style dialogs stay allowed; create/edit/process
 * record titles are routed to RecordFormShell / WizardShell / DetailSheet.
 */
const INVENTORY_LIST_PAGES = [
  "src/pages/Products.tsx",
  "src/pages/warehouse/WarehousesList.tsx",
  "src/pages/Inventory.tsx",
  "src/pages/inventory/Transfers.tsx",
  "src/pages/inventory/ScrapRecording.tsx",
  "src/pages/inventory/PhysicalCount.tsx",
  "src/pages/inventory/UomManagement.tsx",
];

const LEGACY_INLINE_DIALOG_ALLOWLIST = new Set<string>([
  // All legacy inline record dialogs on Inventory list pages have been
  // migrated to routed RecordFormShell / DetailSheet / WizardShell
  // surfaces. This set must stay empty — new entries are forbidden.
]);

const INLINE_INVENTORY_RECORD_DIALOG_TITLE =
  /<DialogTitle[^>]*>[\s\S]*?(?:Add|Create|New|Edit|Record)\s+(?:New\s+)?(?:Product|Warehouse|Stock\s+Transfer|Transfer|Stock\s+Adjustment|Scrap|Waste|UoM\s+Category|Unit\s+of\s+Measure|Category)\b/i;

function scanInlineRecordDialogs(): string[] {
  const leaked: string[] = [];
  for (const p of INVENTORY_LIST_PAGES) {
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    if (INLINE_INVENTORY_RECORD_DIALOG_TITLE.test(src)) leaked.push(p);
  }
  return leaked;
}

describe("inventory record dialog ban", () => {
  it("no NEW Create*Dialog / Edit*Dialog / *DetailDialog / *DetailDrawer files under the Inventory surface", () => {
    const found = scanRecordSurfaces();
    const leaked = found.filter((p) => !LEGACY_DIALOG_ALLOWLIST.has(p));
    expect(
      leaked,
      `New Inventory record dialog/drawer files landed. Build a /new + ` +
        `/:id/edit route on RecordFormShell (create/edit) or a *PeekSheet ` +
        `on PeekScaffold (detail) instead:\n${leaked.join("\n")}`,
    ).toEqual([]);
  });

  it("the legacy allowlist only shrinks — every entry still exists as a file", () => {
    const found = new Set(scanRecordSurfaces());
    const stale = [...LEGACY_DIALOG_ALLOWLIST].filter((p) => !found.has(p));
    expect(
      stale,
      `Allowlist has entries for files that no longer exist — remove them ` +
        `from LEGACY_DIALOG_ALLOWLIST in this test:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("no NEW inline <Dialog> record-create/edit/process blocks on Inventory pages", () => {
    const found = scanInlineRecordDialogs();
    const leaked = found.filter((p) => !LEGACY_INLINE_DIALOG_ALLOWLIST.has(p));
    expect(
      leaked,
      `Inventory pages must use routes, WizardShell, RecordFormShell, or DetailSheet for record forms — inline record Dialogs are banned. Offenders:\n${leaked.join("\n")}`,
    ).toEqual([]);
  });

  it("Product peek surfaces must compose the shared DetailSheet/PeekScaffold — no raw @/components/ui/sheet imports", () => {
    const cmd =
      "find src/components/products -type f -name '*.tsx' 2>/dev/null || true";
    const files = execSync(cmd, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const RAW_SHEET_IMPORT = /from ["']@\/components\/ui\/sheet["']/;
    const offenders = files.filter((f) =>
      RAW_SHEET_IMPORT.test(readFileSync(f, "utf8")),
    );
    expect(
      offenders,
      `Files under src/components/products/** must not import the raw ` +
        `Sheet primitive. Use DetailSheet from @/design-system so peeks ` +
        `share header/footer contract and stay HTML-valid (badges outside ` +
        `SheetDescription).\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
