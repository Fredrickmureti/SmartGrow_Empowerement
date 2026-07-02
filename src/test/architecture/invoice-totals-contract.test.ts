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
    expect(USE_INVOICES_PAGINATED).toContain('from "@/lib/invoiceLineMath"');
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
