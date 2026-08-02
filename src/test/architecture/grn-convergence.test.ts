/**
 * Architecture guard — GRN convergence (Receiving audit, Phase 4d).
 *
 * There is exactly ONE receiving capture path: the WMS receiving session.
 * The Purchases goods-receipt wizard was a second capture UI writing the same
 * physical receipt through a different ledger, so it is retired: the legacy
 * route only forwards deep links, and the GRN is now the *document* produced
 * by posting a session.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "node:fs";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("GRN convergence — one receiving capture path", () => {
  it("the Purchases goods-receipt wizard no longer exists", () => {
    expect(
      existsSync(join(process.cwd(), "src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx")),
    ).toBe(false);
  });

  it("the legacy route forwards to the receiving workspace with the document bound", () => {
    const src = read("src/features/purchases/goods-receipt/GoodsReceiptRedirect.tsx");
    expect(src).toMatch(/Navigate/);
    expect(src).toMatch(/\/warehouse-app\/receiving/);
    expect(src).toMatch(/source_doc_type/);
    expect(src).toMatch(/source_doc_id/);
  });

  it("no client code posts a goods receipt outside session posting", () => {
    const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
      .filter((f) => !f.startsWith("src/test"))
      .filter((f) => !f.includes("integrations/supabase/types"));
    const offenders = files.filter((f) => read(f).includes("complete_goods_receipt_atomic"));
    expect(offenders).toEqual([]);
  });

  it("receiving session posting produces the GRN document", () => {
    const src = read("src/features/warehouse/receiving/useReceivingLines.ts");
    expect(src).toMatch(/wms_post_receiving_session/);
    expect(src).toMatch(/dispatchGoodsReceipt/);
  });

  it("session creation can bind a purchase order or an inbound shipment", () => {
    const src = read("src/pages/warehouse/ReceivingSessions.tsx");
    expect(src).toMatch(/value="purchase_order"/);
    expect(src).toMatch(/value="inbound_shipment"/);
    expect(src).toMatch(/searchParams\.get\("source_doc_type"\)/);
  });

  it("serial-tracked receipts capture one serial per unit", () => {
    const src = read("src/features/warehouse/receiving/ReceivingSessionWorkspace.tsx");
    expect(src).toMatch(/useProductTrackingFlags/);
    expect(src).toMatch(/is_serial_tracked/);
    expect(src).toMatch(/serialInvalid/);
  });
});
