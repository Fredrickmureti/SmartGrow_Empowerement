import { describe, expect, it } from "vitest";
import { computeLine, computeTotals, round2 } from "@/lib/invoiceLineMath";

describe("invoiceLineMath", () => {
  it("0% tax: line_total = qty * price, tax = 0", () => {
    const r = computeLine({ quantity: 10, unit_price: 10000, tax_rate: 0 });
    expect(r.line_total).toBe(100000);
    expect(r.tax_amount).toBe(0);
  });

  it("16% tax-exclusive line: line_total stays tax-exclusive", () => {
    const r = computeLine({ quantity: 10, unit_price: 10000, tax_rate: 16 });
    expect(r.line_total).toBe(100000);
    expect(r.tax_amount).toBe(16000);
  });

  it("discount applies before tax", () => {
    const r = computeLine({ quantity: 10, unit_price: 10000, discount_percent: 10, tax_rate: 16 });
    expect(r.line_total).toBe(90000);
    expect(r.tax_amount).toBe(14400);
  });

  it("rounds to 2dp", () => {
    const r = computeLine({ quantity: 3, unit_price: 33.33, tax_rate: 16 });
    expect(r.line_total).toBe(99.99);
    expect(r.tax_amount).toBe(round2(99.99 * 0.16));
  });

  it("computeTotals matches confirm_invoice_atomic contract", () => {
    const lines = [
      { line_total: 100000, tax_amount: 16000 },
      { line_total: 50, tax_amount: 8 },
    ];
    const t = computeTotals(lines, 0);
    expect(t.subtotal).toBe(100050);
    expect(t.tax_total).toBe(16008);
    expect(t.total).toBe(116058);
  });

  it("header discount applies after subtotal+tax (matches SQL validator)", () => {
    const t = computeTotals([{ line_total: 100000, tax_amount: 16000 }], 1000);
    expect(t.total).toBe(115000);
  });

  it("Scenario A: 10 x 10,000 @ 0% -> 100,000", () => {
    const r = computeLine({ quantity: 10, unit_price: 10000, tax_rate: 0 });
    const t = computeTotals([r], 0);
    expect(t.total).toBe(100000);
  });

  it("Scenario B: 10 x 10,000 @ 16% -> 116,000", () => {
    const r = computeLine({ quantity: 10, unit_price: 10000, tax_rate: 16 });
    const t = computeTotals([r], 0);
    expect(t.subtotal).toBe(100000);
    expect(t.tax_total).toBe(16000);
    expect(t.total).toBe(116000);
  });
});
