/**
 * Phase 6.2 guard — invoice creation is atomic and idempotent.
 *
 * The browser must not create an invoice by inserting a header and then its
 * lines: a failure between the two writes leaves a headless document, and a
 * double submit mints two numbered invoices. `create_invoice_atomic` is the
 * only sanctioned creation path for the invoice editors.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const CREATION_HOOKS = [
  "src/hooks/useInvoices.ts",
  "src/hooks/useInvoicesPaginated.ts",
];

describe("invoice creation is server-atomic", () => {
  it("the shared seam calls create_invoice_atomic with an idempotency key", () => {
    const src = read("src/hooks/invoices/createInvoiceAtomic.ts");
    expect(src).toContain("create_invoice_atomic");
    expect(src).toContain("p_idempotency_key");
    expect(src).toContain("newInvoiceIdempotencyKey");
  });

  it.each(CREATION_HOOKS)("%s creates through the atomic seam", (file) => {
    const src = read(file);
    expect(src).toContain("createInvoiceAtomic");
  });

  it.each(CREATION_HOOKS)("%s never inserts invoice headers or lines", (file) => {
    const src = read(file);
    // No `.from("invoices").insert(` / `.from("invoice_items").insert(`
    const headerInsert = /from\(\s*["']invoices["']\s*\)[\s\S]{0,120}?\.insert\(/.test(src);
    const lineInsert = /from\(\s*["']invoice_items["']\s*\)[\s\S]{0,120}?\.insert\(/.test(src);
    expect(headerInsert).toBe(false);
    expect(lineInsert).toBe(false);
  });

  it("creation hooks do not compute the header totals themselves", () => {
    for (const file of CREATION_HOOKS) {
      const src = read(file);
      expect(src).not.toContain("computeTotals(");
    }
  });
});
