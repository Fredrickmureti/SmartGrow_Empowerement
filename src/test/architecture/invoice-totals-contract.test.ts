/**
 * Invoice totals contract guards.
 *
 * The canonical contract (enforced by `confirm_invoice_atomic`):
 *   invoice_items.line_total  = tax-EXCLUSIVE  (= qty * price * (1 - discount%))
 *   invoice_items.tax_amount  = per-line tax
 *   invoices.subtotal         = SUM(line_total)
 *   invoices.tax_amount       = SUM(tax_amount)
 *   invoices.total            = subtotal + tax - discount_amount
 *
 * The previous tax-inclusive bug expressed itself in two equivalent forms:
 *   1. `line_total: afterDiscount + tax`     (write side)
 *   2. `subtotal += item.line_total - item.tax_amount`  (rollup side)
 *
 * Both are forbidden in invoice / estimate creation paths.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeLine, computeTotals } from "@/lib/invoiceLineMath";

// Phase-3: CreateInvoiceDialog / EditInvoiceDialog retired. The create + edit
// surfaces now live as routes on RecordFormShell.
const CREATE_PAGE = readFileSync("src/features/sales/invoices/InvoiceCreatePage.tsx", "utf8");
const EDIT_PAGE = readFileSync("src/features/sales/invoices/InvoiceEditPage.tsx", "utf8");
const INVOICES_PAGE = readFileSync("src/pages/Invoices.tsx", "utf8");
const USE_INVOICES = readFileSync("src/hooks/useInvoices.ts", "utf8");
const USE_INVOICES_PAGINATED = readFileSync("src/hooks/useInvoicesPaginated.ts", "utf8");
// Phase-3: EditEstimateDialog retired — canonical rollup now lives in the
// EstimateEditPage route file.
const ESTIMATE_EDIT_PAGE = readFileSync("src/features/sales/estimates/EstimateEditPage.tsx", "utf8");

describe("invoice totals contract", () => {
  it("create path uses canonical computeLine / computeTotals helpers", () => {
    expect(CREATE_PAGE).toContain('from "@/lib/invoiceLineMath"');
    expect(EDIT_PAGE).toContain('from "@/lib/invoiceLineMath"');
    expect(INVOICES_PAGE).toContain('from "@/lib/invoiceLineMath"');
    // Phase 6.2: the paginated save path no longer computes money at all —
    // `create_invoice_atomic` owns line money and header totals server-side.
    expect(USE_INVOICES_PAGINATED).toContain("createInvoiceAtomic");
  });

  it("never persists tax-inclusive line_total in invoice/estimate creation paths", () => {
    const offenders = [CREATE_PAGE, EDIT_PAGE, INVOICES_PAGE, ESTIMATE_EDIT_PAGE];
    for (const src of offenders) {
      expect(src).not.toMatch(/line_total:\s*afterDiscount\s*\+\s*tax/);
      expect(src).not.toMatch(/line_total:\s*subtotal\s*\+\s*tax/);
    }
  });

  it("never re-derives header subtotal as SUM(line_total - tax_amount) in saved paths", () => {
    // Save paths must treat line_total as tax-EXCLUSIVE and add it directly to subtotal.
    for (const src of [USE_INVOICES, USE_INVOICES_PAGINATED]) {
      expect(src).not.toMatch(/subtotal\s*\+=\s*item\.line_total\s*-\s*item\.tax_amount/);
    }
    // Estimate edit save path — canonical rollup lives in the route now.
    expect(ESTIMATE_EDIT_PAGE).not.toMatch(/subtotal\s*\+=\s*item\.line_total\s*-\s*item\.tax_amount/);
  });
});

/**
 * Phase 4 milestone 3 — the database owns line tax and document totals.
 * These guards stop a future change from quietly re-promoting the browser to
 * authority over money.
 */
describe("client line math is preview only", () => {
  const LINE_MATH = readFileSync("src/lib/invoiceLineMath.ts", "utf8");

  it("declares itself preview-only and names the server authority", () => {
    expect(LINE_MATH).toMatch(/PREVIEW-ONLY/);
    expect(LINE_MATH).toContain("_totals_normalize_line");
    expect(LINE_MATH).toContain("_recalc_document_totals");
    expect(LINE_MATH).toContain("resolve_line_tax_rate");
  });

  it("mirrors the SQL trigger formula exactly (tax-exclusive, 2dp)", () => {
    // Same arithmetic as _totals_normalize_line(): gross -> discount ->
    // taxable -> tax, each rounded to 2dp.
    const qty = 3, price = 19.99, discountPct = 10, taxRate = 16;
    const gross = Math.round(qty * price * 100) / 100;
    const discount = Math.round((gross * discountPct) / 100 * 100) / 100;
    const taxable = Math.round((gross - discount) * 100) / 100;
    const tax = Math.round((taxable * taxRate) / 100 * 100) / 100;

    const res = computeLine({ quantity: qty, unit_price: price, discount_percent: discountPct, tax_rate: taxRate });
    expect(res.line_total).toBe(taxable);
    expect(res.tax_amount).toBe(tax);
  });

  it("rolls header totals up the same way the recalc trigger does", () => {
    const totals = computeTotals(
      [
        { line_total: 100, tax_amount: 16 },
        { line_total: 53.99, tax_amount: 8.64 },
      ],
      10,
    );
    expect(totals.subtotal).toBe(153.99);
    expect(totals.tax_total).toBe(24.64);
    expect(totals.total).toBe(168.63);
  });
});
