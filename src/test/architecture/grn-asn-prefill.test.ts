/**
 * Architecture guard · Phase D.2 — GRN wizard prefill from ASN.
 *
 * Pins the orchestration contract in `GoodsReceiptWizardPage`:
 *  - loads active `inbound_shipments` for the PO (draft/dispatched/in_transit)
 *  - prefills receipt lines from `inbound_shipment_items.expected_*`
 *  - on post, transitions the shipment to `received` and inserts
 *    `goods_receipt_discrepancies` rows for every over/short line
 *
 * This is a SQL/JSX string-inspection guard — cheaper and more stable than
 * booting the wizard in JSDOM.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WIZARD = readFileSync(
  resolve(__dirname, "../../features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx"),
  "utf-8",
);

describe("GRN wizard · ASN prefill (Phase D.2)", () => {
  it("queries inbound_shipments for the PO", () => {
    expect(WIZARD).toMatch(/from\(["']inbound_shipments["']\)/);
    expect(WIZARD).toMatch(/purchase_order_id["']?\s*,\s*poId/);
  });

  it("filters to active shipment statuses only", () => {
    expect(WIZARD).toMatch(/["']draft["']/);
    expect(WIZARD).toMatch(/["']dispatched["']/);
    expect(WIZARD).toMatch(/["']in_transit["']/);
  });

  it("joins inbound_shipment_items in the shipment query", () => {
    expect(WIZARD).toMatch(/items:inbound_shipment_items\(\*\)/);
  });

  it("prefills receipt lines from ASN expected fields", () => {
    expect(WIZARD).toMatch(/expected_quantity/);
    expect(WIZARD).toMatch(/expected_lot_number/);
    expect(WIZARD).toMatch(/expected_packaging_id/);
  });

  it("tracks the ASN item id on each receipt line for discrepancy linkage", () => {
    expect(WIZARD).toMatch(/inbound_shipment_item_id/);
  });

  it("transitions the shipment to received on post", () => {
    expect(WIZARD).toMatch(
      /from\(["']inbound_shipments["']\)\s*\.update\(\{\s*status:\s*["']received["']/,
    );
    expect(WIZARD).toMatch(/received_at:/);
  });

  it("logs over/short discrepancies into goods_receipt_discrepancies", () => {
    expect(WIZARD).toMatch(/from\(["']goods_receipt_discrepancies["']\)/);
    expect(WIZARD).toMatch(/discrepancy_type:\s*dtype|["']short["']|["']over["']/);
    expect(WIZARD).toMatch(/resolution:\s*["']pending["']/);
  });

  it("scopes discrepancy inserts by organization + business + branch", () => {
    // The insert payload must carry tenant scoping so RLS accepts it.
    const insertBlock = WIZARD.match(
      /discrepancies\.push\(\{[\s\S]*?\}\);/,
    )?.[0];
    expect(insertBlock).toBeTruthy();
    expect(insertBlock!).toMatch(/organization_id/);
    expect(insertBlock!).toMatch(/business_id/);
    expect(insertBlock!).toMatch(/branch_id/);
    expect(insertBlock!).toMatch(/goods_receipt_id/);
    expect(insertBlock!).toMatch(/inbound_shipment_item_id/);
  });

  it("skips discrepancy logging when received == expected", () => {
    expect(WIZARD).toMatch(/received === expected/);
  });
});
