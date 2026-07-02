/**
 * Architecture guard — `warehouse_stock` reads.
 *
 * Branch-true on-hand reads should flow through `getProductOnHand()` in
 * `src/lib/inventory/readOnHand.ts`. Direct `.from("warehouse_stock")`
 * reads scattered across components/pages are a recurring leak source —
 * authors forget to add `.eq('business_id', ...)` and `.eq('branch_id', ...)`,
 * relying on RLS alone, which has historically been the exact bug pattern
 * that produced cross-branch contamination.
 *
 * Files that legitimately need a direct read (warehouse-pinned UIs that
 * filter explicitly by `warehouse_id`, the real-time channel, the helper
 * itself) are allowlisted.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPES = [
  "src/components/inventory",
  "src/pages/inventory",
];

// Files that may read warehouse_stock directly. Anything not on this list
// MUST go through getProductOnHand() in src/lib/inventory/readOnHand.ts.
const ALLOWLIST = new Set<string>([
  // Per-warehouse physical count: query is keyed on warehouse_id and is the
  // source-of-truth read for the count baseline.
  "src/pages/inventory/PhysicalCount.tsx",
  // Movement & adjustment drawers: scoped by reference, not branch.
  "src/components/inventory/SourceDocumentDrawer.tsx",
  "src/components/inventory/MovementDetailDrawer.tsx",
  "src/components/inventory/AdjustmentDetailDrawer.tsx",
  // ProductDetailPanel reads warehouse_stock filtered by org+business+branch
  // via useProductDetailData. Validated by inventory-branch-filter.
  "src/hooks/inventory/useProductDetailData.ts",
]);

// Pages outside SCOPES that also need to be checked.
const EXTRA_FILES: string[] = [
  // Stock Levels tab on /inventory/stock — branch-scoped via business_id.
  // It is allowlisted here because its query is verified by the
  // inventory-branch-filter test.
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const FROM_RE = /\.from\(\s*["']warehouse_stock["']\s*\)/;

describe("warehouse_stock reads should go through getProductOnHand()", () => {
  it("no scattered direct reads outside the allowlist", () => {
    const files: string[] = [];
    for (const s of SCOPES) files.push(...walk(s));
    for (const f of EXTRA_FILES) files.push(f);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (FROM_RE.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      `These files read warehouse_stock directly. Use ` +
        `getProductOnHand() from src/lib/inventory/readOnHand.ts (which ` +
        `enforces org + business + optional branch filters), or, if the ` +
        `read is intentionally per-warehouse, add the file to the ` +
        `ALLOWLIST in this test with a justification.\n\nOffenders:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
