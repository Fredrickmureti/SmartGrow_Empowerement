/**
 * Phase 7 — sale-time tax authority.
 *
 * `resolve_sales_line_tax(business, product, contact, date, tax_rate_id, rate)`
 * is the ONE place a Sales line's tax is decided. It is invoked by the
 * `_totals_normalize_line()` trigger on every Sales line table, so no browser
 * code — and no client-supplied `tax_rate` — can be authoritative.
 *
 * These guards stop a future change from re-promoting React (or an unvalidated
 * client rate) to tax authority.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const LINE_MATH = readFileSync("src/lib/invoiceLineMath.ts", "utf8");

const SALES_EDITORS = [
  "src/features/sales/invoices/InvoiceCreatePage.tsx",
  "src/features/sales/invoices/InvoiceEditPage.tsx",
  "src/features/sales/orders/SalesOrderCreatePage.tsx",
  "src/features/sales/estimates/EstimateCreatePage.tsx",
  "src/features/sales/estimates/EstimateEditPage.tsx",
  "src/features/sales/proforma/ProformaCreatePage.tsx",
  "src/features/sales/credit-notes/CreditNoteCreatePage.tsx",
];

describe("sale-time tax authority", () => {
  it("client line math names the server resolver and stays preview-only", () => {
    expect(LINE_MATH).toMatch(/PREVIEW-ONLY/);
    expect(LINE_MATH).toContain("resolve_sales_line_tax");
    expect(LINE_MATH).toContain("_totals_normalize_line");
  });

  it("documents the Phase 7 invariants the trigger enforces", () => {
    for (const invariant of [
      "DOCUMENT's own date",
      "tax_rate_id",
      "fixed_amount",
      "compound",
    ]) {
      expect(LINE_MATH).toContain(invariant);
    }
  });

  it("no Sales editor derives a tax rate from tax_rates in the browser", () => {
    for (const path of SALES_EDITORS) {
      const src = readFileSync(path, "utf8");
      // Reading the configured rates to POPULATE a picker is fine; issuing a
      // direct table query to DECIDE the rate is not.
      expect(src, `${path} must not query tax_rates directly`).not.toMatch(
        /\.from\(\s*["'`]tax_rates["'`]\s*\)/,
      );
    }
  });
});
