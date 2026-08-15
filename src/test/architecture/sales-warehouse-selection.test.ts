/**
 * Phase 6b guard — a Sales document that commits stock must record the
 * warehouse it commits from, and must read availability from that same
 * warehouse.
 *
 * The failure this prevents: an editor reads the branch-wide aggregate
 * (`useBranchScopedProducts()` with no warehouse) while the server reserves
 * and issues from ONE warehouse (`resolve_sales_warehouse`). The operator then
 * sees 30 available and commits 30 against a warehouse holding 12.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const COMMIT_EDITORS = [
  "src/features/sales/invoices/InvoiceCreatePage.tsx",
  "src/features/sales/orders/SalesOrderCreatePage.tsx",
  "src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx",
];

describe("sales warehouse selection", () => {
  for (const file of COMMIT_EDITORS) {
    it(`${file} scopes availability to the chosen warehouse`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("useSalesWarehouse");
      expect(src).toMatch(/useBranchScopedProducts\(\{[\s\S]*?warehouseId/);
      expect(src).toContain("warehouse_id: warehouse.warehouseId");
    });
  }

  it("the product/stock list forwards the warehouse to the server", () => {
    const src = readFileSync("src/hooks/useBranchScopedProducts.ts", "utf8");
    expect(src).toContain("p_warehouse_id");
    // Query key must include it, or a warehouse switch serves stale figures.
    expect(src).toMatch(/queryKey: \[[\s\S]*?warehouseId/);
  });

  it("invoice confirmation issues from the recorded warehouse", () => {
    const src = readFileSync("src/hooks/invoices/confirmInvoiceGL.ts", "utf8");
    expect(src).toContain("p_warehouse_id: invoice.warehouse_id");
    expect(src).not.toMatch(/p_warehouse_id:\s*null/);
  });
});
