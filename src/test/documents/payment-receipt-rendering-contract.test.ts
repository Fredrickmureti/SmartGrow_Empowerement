/**
 * A payment receipt is a cash-application document, not a sale.
 *
 * These are source-level guards: the renderers live in the Deno edge bundle,
 * so we assert the invariants at the module text level rather than importing
 * `pdf-lib`-dependent code into the browser test runner.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("payment receipt rendering contract", () => {
  it("A4 renderer routes every receipt through the allocation ledger", () => {
    const src = read("supabase/functions/_shared/pdfGenerator.ts");
    expect(src).toContain('const isPaymentReceipt = data.document_type === "receipt"');
    expect(src).toMatch(/if \(isPaymentReceipt\)/);
  });

  it("A4 renderer does not restate a totals block on receipts", () => {
    const src = read("supabase/functions/_shared/pdfGenerator.ts");
    expect(src).toContain('!data.hide_amounts && data.document_type !== "receipt"');
  });

  it("thermal engine treats 'receipt' as a payment document, not a POS sale", () => {
    const src = read("supabase/functions/_shared/receipt/documentToInput.ts");
    const posTypes = src.match(/POS_TYPES[^;]*;/s)?.[0] ?? "";
    expect(posTypes).not.toMatch(/["']receipt["']/);
    expect(src).toMatch(/PAYMENT_TYPES[^;]*["']receipt["']/s);
  });

  it("thermal engine typesets allocations with a width-aware column plan", () => {
    const src = read("supabase/functions/_shared/receipt/lines.ts");
    expect(src).toMatch(/payment_allocations/);
    expect(src).toMatch(/ColumnLayout|columns/);
  });

  it("payment receipt is a first-class entry in the output policy catalogue", () => {
    const src = read("src/hooks/useDocumentPrintPolicies.ts");
    expect(src).toContain("Payment receipt (customer)");
    expect(src).toContain("kitchen_ticket");
  });
});
