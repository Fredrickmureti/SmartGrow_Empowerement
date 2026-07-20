/**
 * ADR-0086 cross-model consistency contract.
 *
 * `ReceiptDocumentModel` (client UI shape) and `DocumentData` (server print
 * shape) intentionally coexist. This test locks the invariant that keeps them
 * safe: for a given `pos_receipt_snapshots.payload`, the numeric totals and
 * item lines derived by the UI model MUST equal the raw canonical values that
 * the server print pipeline (via `fetchPOSReceipt` → `DocumentData`) consumes
 * from the same snapshot.
 *
 * If this test fails, the client model has diverged from the frozen truth.
 * The fix is NEVER to loosen the assertion — it is to correct
 * `buildReceiptDocument` so it derives every displayed number from the
 * snapshot rows the print pipeline uses.
 */
import { describe, expect, it } from "vitest";
import { buildReceiptDocument } from "@/lib/pos/receipt/ReceiptDocumentModel";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";

const liveBranding = {
  business_name: "Fallback Biz",
  logo_url: null,
  address: null,
  city: null,
  phone: null,
  email: null,
  tax_id: null,
};

// Canonical frozen snapshot — this is the exact shape the server reads via
// `fetchPOSReceipt` when composing `DocumentData` for the print pipeline.
const snapshot: POSReceiptSnapshot = {
  transaction: {
    id: "txn-42",
    transaction_number: "POS-0042",
    total_amount: 1900,
    subtotal: 1700,
    tax_amount: 200,
    discount_amount: 0,
    created_at: "2026-07-20T10:00:00Z",
    register_id: "reg-1",
    invoice_id: null,
    invoice_number: null,
    etims_cu_number: "KRAABC123",
    etims_qr_data: "https://etims.example/qr/abc",
    is_voided: false,
    is_refund: false,
  } as unknown as POSReceiptSnapshot["transaction"],
  items: [
    {
      product_name: "Widget",
      sku: "SKU-1",
      quantity: 2,
      unit_price: 500,
      discount_amount: 0,
      line_total: 1000,
    },
    {
      product_name: "Gadget",
      sku: "SKU-2",
      quantity: 1,
      unit_price: 700,
      discount_amount: 0,
      line_total: 700,
    },
  ] as unknown as POSReceiptSnapshot["items"],
  payments: [
    { payment_method: "cash", amount: 1900, tendered_amount: 2000, change_given: 100 },
  ] as unknown as POSReceiptSnapshot["payments"],
  business: { name: "Snapshot Biz" },
  branch: { address: "1 Snapshot Rd", city: "Nairobi", phone: "0700000000" },
  cashier: { name: "Alice" },
  customer: { name: "Bob" },
  business_receipt_settings: DEFAULT_EXTENDED_RECEIPT_SETTINGS as unknown as Record<string, unknown>,
  register_receipt_settings: null,
} as unknown as POSReceiptSnapshot;

// The unused `live` fallback — the UI model must ignore it when a snapshot
// exists. Providing wrong values here proves the snapshot took precedence.
const live = {
  id: "txn-42",
  transaction_number: "WRONG",
  total_amount: 0,
  subtotal: 0,
  tax_amount: 0,
  discount_amount: 999,
  created_at: "1970-01-01T00:00:00Z",
  items: [],
  payments: [],
};

describe("ADR-0086 — cross-model consistency (UI ↔ Print)", () => {
  const model = buildReceiptDocument({
    snapshot,
    live,
    liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
    liveBranding,
  });

  it("UI totals equal the frozen snapshot values (what the print pipeline reads)", () => {
    expect(model.totals.total_amount).toBe(1900);
    expect(model.totals.subtotal).toBe(1700);
    expect(model.totals.tax_amount).toBe(200);
    expect(model.totals.discount_amount).toBe(0);
  });

  it("UI tender/change reflect what the customer actually presented", () => {
    // Print pipeline emits tendered=2000, change=100; UI must agree.
    expect(model.totals.amount_tendered).toBe(2000);
    expect(model.totals.change_due).toBe(100);
  });

  it("UI item lines equal the snapshot rows the print pipeline emits", () => {
    expect(model.items).toHaveLength(2);
    expect(model.items[0]).toMatchObject({
      product_name: "Widget",
      sku: "SKU-1",
      quantity: 2,
      unit_price: 500,
      line_total: 1000,
    });
    expect(model.items[1]).toMatchObject({
      product_name: "Gadget",
      quantity: 1,
      unit_price: 700,
      line_total: 700,
    });
  });

  it("UI meta pulls transaction identity + eTIMS from the snapshot", () => {
    expect(model.meta.transaction_number).toBe("POS-0042");
    expect(model.meta.etims_cu_number).toBe("KRAABC123");
    expect(model.meta.etims_qr_data).toBe("https://etims.example/qr/abc");
    // Not "WRONG" from the live-fallback branch.
  });

  it("UI header pulls branding from the snapshot business/branch rows", () => {
    expect(model.header.business_name).toBe("Snapshot Biz");
    expect(model.header.address).toBe("1 Snapshot Rd");
    expect(model.header.city).toBe("Nairobi");
  });
});
