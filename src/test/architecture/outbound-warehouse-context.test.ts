/**
 * Architecture guard — outbound lot/serial pickers must receive the
 * document's warehouse.
 *
 * Regression pinned: `InvoiceLineRow` rendered `OutboundLineTracking`
 * without a `warehouseId`, so the picker fell back to the branch's
 * `default_warehouse_id`. That column is frequently NULL, which disabled
 * the FEFO query and made the line report "No lots available" while the
 * warehouse actually held stock.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("outbound warehouse context", () => {
  it("InvoiceLineRow forwards a warehouseId to OutboundLineTracking", () => {
    const src = read("src/components/invoices/InvoiceLineRow.tsx");
    expect(src).toMatch(/warehouseId\?:\s*string\s*\|\s*null/);
    expect(src).toMatch(/<OutboundLineTracking[\s\S]{0,400}warehouseId=\{warehouseId/);
  });

  it("invoice create and edit surfaces pass the document warehouse to the row", () => {
    for (const file of [
      "src/features/sales/invoices/InvoiceCreatePage.tsx",
      "src/features/sales/invoices/InvoiceEditPage.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/<InvoiceLineRow[\s\S]{0,400}warehouseId=\{/);
    }
  });

  it("delivery note lines pass the document warehouse to the tracking cell", () => {
    const src = read("src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx");
    expect(src).toMatch(/<OutboundLineTracking[\s\S]{0,400}warehouseId=\{warehouse\.warehouseId/);
  });

  it("LotPickerPopover distinguishes missing warehouse context from no stock", () => {
    const src = read("src/components/inventory/LotPickerPopover.tsx");
    expect(src).toMatch(/missingContext\s*=\s*!businessId\s*\|\|\s*!warehouseId/);
    expect(src).toMatch(/Select a warehouse/);
  });
});
