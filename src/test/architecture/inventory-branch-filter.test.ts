/**
 * Architecture guard test — fails CI if a hook or page that queries the
 * inventory tables (stock_movements, warehouse_stock, stock_adjustments)
 * does so without ever filtering by branch_id when a currentBranch is in
 * scope.
 *
 * Per ARCHITECTURE.md, branch is the operational boundary for inventory.
 * Reading these tables without a branch filter risks cross-branch
 * contamination on dashboards, drawers, and reports.
 *
 * The ALLOWLIST is for files that are legitimately company-wide:
 *   - HQ-level consolidation reports
 *   - Migration/import tooling
 *   - Org-wide reset utilities
 *   - Realtime subscription channels (subscribe to all, filter client-side)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TABLES = /\.from\(\s*["'](stock_movements|warehouse_stock|stock_adjustments)["']/;
const HAS_BRANCH_FILTER = /branch_id|currentBranch|useBranch/;

const SCOPES = ["src/hooks", "src/pages", "src/components"];

const ALLOWLIST = new Set<string>([
  // Realtime: subscribes to broad channel, filters per-render.
  "src/hooks/useInventoryRealtime.ts",
  // Import/migration paths: data exists pre-branch-context.
  "src/hooks/useMigrationSession.ts",
  "src/components/migration/steps/MigrationStepInventory.tsx",
  "src/components/migration/steps/MigrationStepValidation.tsx",
  // Reversal & history utilities: scope is the original document, not the
  // current branch context.
  "src/hooks/useTransactionReversal.ts",
  "src/hooks/pos/usePOSTransactionHistory.ts",
  // Org-wide reset tool (admin-only).
  "src/components/settings/OrgDataResetTool.tsx",
  // Source-document drawers: scoped by reference_id, not branch.
  "src/components/inventory/SourceDocumentBadge.tsx",
  "src/components/inventory/SourceDocumentDrawer.tsx",
  "src/components/inventory/MovementDetailDrawer.tsx",
  "src/components/inventory/AdjustmentDetailDrawer.tsx",
  // Product detail panel reads warehouse_stock filtered by org+business+branch
  // through useProductDetailData. Allowed.
  "src/hooks/inventory/useProductDetailData.ts",
]);

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

describe("inventory hooks/pages must filter by branch_id", () => {
  it("every file touching inventory tables references branch context", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        if (ALLOWLIST.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (!TABLES.test(src)) continue;
        if (!HAS_BRANCH_FILTER.test(src)) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `These files query stock_movements/warehouse_stock/stock_adjustments ` +
        `without referencing branch_id or currentBranch. Add a branch filter ` +
        `or, if intentionally company-wide, add to the ALLOWLIST in this test ` +
        `with a justification.\n\nOffenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // Stage D.4 — guard against regressions where someone uses the deprecated
  // products.stock_quantity aggregate as a decision input. The column is kept
  // for legacy reads but must NEVER drive low-stock, replenishment, POS
  // availability, or reservation logic.
  it("no client code reads products.stock_quantity for stock decisions", () => {
    const STOCK_QTY_RE = /products?\.stock_quantity|"stock_quantity"|'stock_quantity'/;
    const DECISION_KEYWORDS = /reorder|replenish|low.?stock|available|reserve|out.?of.?stock|in.?stock/i;
    const STOCK_QTY_ALLOWLIST = new Set<string>([
      // Migration tooling reads legacy aggregate to seed warehouse_stock.
      "src/components/migration/steps/MigrationStepInventory.tsx",
      // The architecture tests themselves reference the column name.
      "src/test/architecture/inventory-branch-filter.test.ts",
      // (ProductDetailDrawer removed from this allowlist — it now reads
      // branch-true on-hand from warehouse_stock, not products.stock_quantity.)
      // Interface field declaration only; the POS Low badge decision now reads
      // branchOnHand from warehouse_stock (Phase 1, plan 8F42B1C3).
      "src/hooks/pos/usePOSProducts.ts",
    ]);
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        if (STOCK_QTY_ALLOWLIST.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (!STOCK_QTY_RE.test(src)) continue;
        // Only flag if the file ALSO mentions decision keywords — pure display
        // reads (e.g. a product detail page) are acceptable.
        if (DECISION_KEYWORDS.test(src)) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `These files use products.stock_quantity in a context that looks like a ` +
        `stock decision (reorder/availability/reservation). Read warehouse_stock ` +
        `filtered by (business_id, branch_id) instead, or add to ` +
        `STOCK_QTY_ALLOWLIST with justification.\n\nOffenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
