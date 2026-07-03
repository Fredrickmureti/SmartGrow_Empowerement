/**
 * Architecture guard — any component under src/pages/(Products|Inventory|inventory)
 * or src/components/(products|inventory) that renders an inventory base
 * quantity (warehouse_stock.quantity, on_hand, stock_quantity, reserved
 * quantity, available quantity) must route the display through the
 * canonical formatter (`@/lib/inventory/formatQty` or the
 * `@/lib/packagingRollup` re-export) OR delegate rendering to a child
 * component that does (StockCell, ReservedPopover, etc.).
 *
 * Without this guard, a future regression could re-introduce raw-base
 * quantities in a listing or drawer and silently break the multi-unit
 * presentation contract described in mem://features/multi-unit-inventory.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPES = [
  "src/pages/Products.tsx",
  "src/pages/Inventory.tsx",
  "src/pages/inventory",
  "src/components/products",
  "src/components/inventory",
];

// Files exempted because they either don't render a base qty in the UI
// (read-only RPC plumbing, type defs, dialogs that delegate to StockCell),
// or they ARE the formatter / its tests.
const ALLOWLIST = new Set<string>([
  "src/lib/inventory/formatQty.ts",
  // The formatter is re-exported via packagingRollup; cells that use the
  // re-export are fine. The allowlist below covers components that pass qty
  // through props to other formatter-using components OR display non-qty data.
  "src/components/inventory/SourceDocumentBadge.tsx",
  "src/components/inventory/SourceDocumentPeekSheet.tsx",
  "src/components/inventory/StockMovementPeekSheet.tsx",
  "src/components/inventory/AdjustmentDetailDrawer.tsx",
  "src/components/inventory/ActiveBranchBadge.tsx",
  "src/components/inventory/WarehouseBadge.tsx",
  "src/components/inventory/BranchScopeGate.tsx",
  "src/components/inventory/WarehouseScopeGate.tsx",
  // Pre-existing surfaces still on raw base-qty display. Migrating these
  // is a separate phase (G7 — count/transfer/forecast tabs). The guard
  // locks in current state so NEW files cannot add raw qty rendering.
  "src/pages/inventory/Forecast.tsx",
  "src/pages/inventory/PhysicalCount.tsx",
  "src/pages/inventory/ScrapRecording.tsx",
  "src/components/products/ProductStockPanel.tsx",
  "src/components/products/detail/tabs/LotsExpiryTab.tsx",
  "src/components/inventory/StockTransferPeekSheet.tsx",
]);

const QTY_REFERENCE = /\b(warehouse_stock\.quantity|stock_quantity|on_hand|reserved_quantity|available_quantity|\.quantity\b)/;
const FORMATTER_IMPORT = /@\/lib\/inventory\/formatQty|@\/lib\/packagingRollup|<StockCell\b/;

function walk(p: string, out: string[] = []): string[] {
  let st;
  try { st = statSync(p); } catch { return out; }
  if (st.isFile()) {
    if (/\.(ts|tsx)$/.test(p)) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) walk(join(p, name), out);
  return out;
}

describe("qty display uses formatter", () => {
  it("every product/inventory UI surface that renders a base qty routes through formatQty", () => {
    const files = SCOPES.flatMap((s) => walk(s));
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      if (rel.includes("__tests__") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      // Only flag files that actually render the qty visually (JSX). Pure
      // data hooks/types may reference `.quantity` while passing it onward.
      const looksLikeUI = /\.tsx$/.test(f);
      if (!looksLikeUI) continue;
      if (!QTY_REFERENCE.test(src)) continue;
      if (FORMATTER_IMPORT.test(src)) continue;
      offenders.push(rel);
    }
    expect(offenders, `Files render an inventory base qty without the formatter:\n${offenders.join("\n")}`)
      .toEqual([]);
  });
});