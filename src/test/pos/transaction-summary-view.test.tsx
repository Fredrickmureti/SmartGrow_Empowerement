/**
 * Architecture/visual guard: TransactionSummaryView must be a screen-first
 * presentation of the receipt model — no font-mono and no fixed paper-strip
 * widths (40mm/58mm/80mm). The thermal-strip simulation lives in
 * PreviewRenderer / MonospacePreview and is not allowed to leak in here.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TransactionSummaryView } from "@/components/pos/TransactionSummaryView";
import type { ReceiptDocumentModel } from "@/lib/pos/receipt/ReceiptDocumentModel";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ formatCurrency: (n: number) => `$${n.toFixed(2)}` }),
}));

const model: ReceiptDocumentModel = {
  meta: {
    transaction_id: "t1",
    transaction_number: "RCP-001",
    created_at: new Date("2026-05-14T10:00:00Z").toISOString(),
    customer_name: "Jane",
    cashier_name: "John",
    register_id: null,
    invoice_id: null,
    invoice_number: null,
    etims_cu_number: null,
    etims_qr_data: null,
    title: "SALES RECEIPT",
  },
  header: {
    business_name: "Acme",
    logo_url: null,
    address: "1 Main",
    city: "Nairobi",
    phone: null,
    email: null,
    tax_id: null,
    header_text: null,
  },
  items: [
    { product_name: "Coffee", sku: "C1", quantity: 2, unit_price: 5, line_total: 10 },
  ],
  totals: {
    subtotal: 10,
    discount_amount: 0,
    tax_amount: 1.5,
    total_amount: 11.5,
    change_due: 8.5,
    amount_tendered: 20,
  },
  payments: [{ payment_method: "cash", amount: 11.5, tendered_amount: 20, change_given: 8.5 }],
  footer_text: null,
  return_policy_text: null,
  flags: { is_voided: false, is_refund: false, is_reprint: false, is_offline: false },
  settings: DEFAULT_EXTENDED_RECEIPT_SETTINGS,
};

describe("TransactionSummaryView", () => {
  it("renders totals, items and change without paper-strip styling", () => {
    const { container } = render(<TransactionSummaryView model={model} />);
    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(screen.getAllByText("$11.50").length).toBeGreaterThan(0);
    expect(screen.getByText(/Change due/)).toBeInTheDocument();
    const root = container.querySelector('[data-testid="transaction-summary-view"]') as HTMLElement;
    expect(root).toBeTruthy();
    // No thermal-strip: no font-mono on the root, no fixed-mm width inline style.
    const html = root.outerHTML;
    expect(html).not.toMatch(/font-mono\b/);
    expect(html).not.toMatch(/width:\s*(40|58|80)mm/);
  });
});
