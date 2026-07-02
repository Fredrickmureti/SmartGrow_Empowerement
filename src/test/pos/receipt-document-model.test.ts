/**
 * Stage X1 — ReceiptDocumentModel builder coverage.
 *
 * Locks the canonical mapping rules: snapshot wins over live data,
 * change_due is derived from tendered − total, and reprint flag flows
 * through to renderers as a watermark hint.
 */
import { describe, expect, it } from "vitest";
import { buildReceiptDocument } from "@/lib/pos/receipt/ReceiptDocumentModel";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";

const baseLive = {
  id: "txn-1",
  transaction_number: "POS-0001",
  total_amount: 100,
  subtotal: 90,
  tax_amount: 10,
  discount_amount: 0,
  created_at: "2026-05-12T10:00:00Z",
  customer_name: "Live Customer",
  cashier_name: "Live Cashier",
  register_id: "reg-1",
  invoice_id: null,
  invoice_number: null,
  etims_cu_number: null,
  etims_qr_data: null,
  items: [{ product_name: "Widget", quantity: 2, unit_price: 45, line_total: 90 }],
  payments: [{ payment_method: "cash", amount: 120 }],
};

const liveBranding = {
  business_name: "Live Biz",
  logo_url: null,
  address: null,
  city: null,
  phone: null,
  email: null,
  tax_id: null,
};

describe("buildReceiptDocument — change due derivation", () => {
  it("computes change_due from tendered minus total", () => {
    const model = buildReceiptDocument({
      live: baseLive,
      liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
      liveBranding,
    });
    expect(model.totals.amount_tendered).toBe(120);
    expect(model.totals.change_due).toBe(20);
  });

  it("clamps change_due at 0 when underpaid (split tender mid-flow)", () => {
    const model = buildReceiptDocument({
      live: { ...baseLive, payments: [{ payment_method: "cash", amount: 50 }] },
      liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
      liveBranding,
    });
    expect(model.totals.change_due).toBe(0);
  });
});

describe("buildReceiptDocument — snapshot precedence", () => {
  it("prefers snapshot business name over live branding", () => {
    const snapshot: POSReceiptSnapshot = {
      schema_version: 1,
      transaction: {
        transaction_number: "POS-0001",
        created_at: "2026-05-12T10:00:00Z",
        total_amount: 100,
        subtotal: 90,
        tax_amount: 10,
        discount_amount: 0,
      },
      items: [{ product_name: "Snapshot Widget", quantity: 1, unit_price: 90, line_total: 90 }],
      payments: [{ payment_method: "cash", amount: 100 }],
      business: { name: "Snapshot Biz", logo_url: null, address: null, city: null, phone: null, email: null, tax_id: "P051" },
      branch: null,
      organization: null,
      customer: { name: "Snapshot Customer" },
      cashier: { id: null, name: "Snapshot Cashier", email: null },
      register: null,
      business_receipt_settings: null,
      register_receipt_settings: null,
    };
    const model = buildReceiptDocument({
      snapshot,
      live: baseLive,
      liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
      liveBranding,
    });
    expect(model.header.business_name).toBe("Snapshot Biz");
    expect(model.header.tax_id).toBe("P051");
    expect(model.meta.customer_name).toBe("Snapshot Customer");
    expect(model.meta.cashier_name).toBe("Snapshot Cashier");
    expect(model.items[0].product_name).toBe("Snapshot Widget");
  });
});

describe("buildReceiptDocument — flags", () => {
  it("propagates is_reprint into the model", () => {
    const model = buildReceiptDocument({
      live: baseLive,
      liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
      liveBranding,
      isReprint: true,
    });
    expect(model.flags.is_reprint).toBe(true);
    expect(model.flags.is_voided).toBe(false);
    expect(model.flags.is_refund).toBe(false);
  });

  it("respects is_voided / is_refund on the live txn", () => {
    const model = buildReceiptDocument({
      live: { ...baseLive, is_voided: true },
      liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
      liveBranding,
    });
    expect(model.flags.is_voided).toBe(true);
  });
});

describe("buildReceiptDocument — data-plumbing regressions (2026-05-13)", () => {
  it("Bug 1: legacy snapshots that only stored `description` still render the product name", () => {
    const snapshot: POSReceiptSnapshot = {
      schema_version: 1,
      transaction: { transaction_number: "POS-9", created_at: baseLive.created_at, total_amount: 100, subtotal: 100, tax_amount: 0, discount_amount: 0 },
      items: [{ description: "Coca-Cola 500ml", quantity: 2, unit_price: 50, line_total: 100 } as any],
      payments: [{ payment_method: "cash", amount: 100 }],
      business: { name: "Biz" }, branch: null, organization: null, customer: null, cashier: null, register: null,
      business_receipt_settings: null, register_receipt_settings: null,
    };
    const model = buildReceiptDocument({ snapshot, live: baseLive, liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS, liveBranding });
    expect(model.items[0].product_name).toBe("Coca-Cola 500ml");
    expect(model.items[0].product_name).not.toBe("Item");
  });

  it("Bug 2: empty snapshot settings rows fall back to liveSettings instead of collapsing to {}", () => {
    const snapshot: POSReceiptSnapshot = {
      schema_version: 2,
      transaction: { transaction_number: "POS-9", created_at: baseLive.created_at, total_amount: 100, subtotal: 90, tax_amount: 10, discount_amount: 0 },
      items: [{ product_name: "Widget", quantity: 2, unit_price: 45, line_total: 90 }],
      payments: [{ payment_method: "mpesa", amount: 100, reference: "TXX" }],
      business: { name: "Biz" }, branch: null, organization: null, customer: null, cashier: null, register: null,
      business_receipt_settings: null,
      register_receipt_settings: null,
    };
    const model = buildReceiptDocument({ snapshot, live: baseLive, liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS, liveBranding });
    expect(model.settings.show_item_quantity).toBe(true);
    expect(model.settings.show_payment_method).toBe(true);
    expect(model.settings.show_subtotal).toBe(true);
    expect(model.settings.show_etims_qr).toBe(true);
  });

  it("Bug 3: live txn with eTIMS QR populates the meta block for first-paint preview", () => {
    const model = buildReceiptDocument({
      live: { ...baseLive, etims_qr_data: "https://etims.kra.go.ke/q/abc", etims_cu_number: "CU01234" },
      liveSettings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
      liveBranding,
    });
    expect(model.meta.etims_qr_data).toBe("https://etims.kra.go.ke/q/abc");
    expect(model.meta.etims_cu_number).toBe("CU01234");
  });
});
