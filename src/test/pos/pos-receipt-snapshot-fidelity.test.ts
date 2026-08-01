/**
 * Regression: the printed receipt must carry the same money and identity
 * fields the on-screen preview shows.
 *
 * Field shape below is a verbatim (trimmed) `pos_receipt_snapshots.payload`
 * row from production: the transaction uses `subtotal` / `total` /
 * `transaction_number`, NOT the `*_amount` naming the builder originally
 * assumed. Reading the wrong keys printed "Subtotal 0.00 / TOTAL 0.00" on
 * paper while the preview showed the correct totals.
 */
import { describe, expect, it } from "vitest";
import { buildPosReceiptSnapshot } from "@/services/documents/snapshots/posReceipt";
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";

const frozen = {
  schema_version: 1,
  transaction: {
    id: "620dffdc-fe35-4cd7-b010-89b2b1bde79f",
    transaction_number: "POS1-260801-0004",
    status: "completed",
    subtotal: "160.00",
    total: "160.00",
    tax_amount: "0.00",
    discount_amount: "0.00",
    created_at: "2026-08-01T13:17:00.000Z",
    completed_at: "2026-08-01T13:17:00.000Z",
  },
  items: [
    {
      product_name: "Lemonade Soda 300ML",
      description: "Lemonade Soda 300ML",
      sku: "LM-300ML",
      quantity: 2,
      unit_price: 80,
      line_total: 160,
      tax_amount: 0,
      tax_rate: 0,
    },
  ],
  payments: [{ payment_method: "cash", amount: 160, reference: null }],
  business_receipt_settings: { item_display_format: "two-lines" },
  register_receipt_settings: null,
} as unknown as POSReceiptSnapshot;

describe("buildPosReceiptSnapshot — print/preview parity", () => {
  it("carries the transaction money columns onto the printed snapshot", () => {
    const { snapshot, documentNumber } = buildPosReceiptSnapshot({ frozen });
    expect(snapshot.subtotal).toBe(160);
    expect(snapshot.total).toBe(160);
    expect(snapshot.amount_paid).toBe(160);
    expect(documentNumber).toBe("POS1-260801-0004");
    expect(snapshot.document_number).toBe("POS1-260801-0004");
    expect(snapshot.issue_date).toBeTruthy();
  });

  it("carries the resolved presentation profile so paper matches preview", () => {
    const { snapshot } = buildPosReceiptSnapshot({ frozen });
    const rs = snapshot.pos_receipt_settings as Record<string, unknown>;
    expect(rs.item_display_format).toBe("two-lines");
  });

  it("never prints zero totals when the transaction row loses its columns", () => {
    const degraded = {
      ...frozen,
      transaction: { transaction_number: "POS1-260801-0004", status: "completed" },
    } as unknown as POSReceiptSnapshot;
    const { snapshot } = buildPosReceiptSnapshot({ frozen: degraded });
    expect(snapshot.subtotal).toBe(160);
    expect(snapshot.total).toBe(160);
  });
});
