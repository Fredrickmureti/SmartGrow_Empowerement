import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Phase 10 — double-submit safety for Sales document creation.
 *
 * Every atomic creator claims an idempotency key in
 * `public.sales_document_idempotency` before it writes, so a retry, refresh or
 * double click replays the first document. The create forms must hold ONE key
 * per form instance — a key minted inside the submit handler would change on
 * every attempt and defeat the mechanism.
 */
describe("sales idempotency contract", () => {
  const CREATORS: Array<[string, string]> = [
    ["src/hooks/invoices/createInvoiceAtomic.ts", "create_invoice_atomic"],
    ["src/hooks/estimates/estimateWriter.ts", "create_estimate_atomic"],
    ["src/hooks/useSalesOrders.ts", "create_sales_order_atomic"],
  ];

  it.each(CREATORS)("%s passes an idempotency key to %s", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("p_idempotency_key");
  });

  const FORMS = [
    "src/features/sales/orders/SalesOrderCreatePage.tsx",
    "src/features/sales/credit-notes/CreditNoteCreatePage.tsx",
  ];

  it.each(FORMS)("%s holds one key per form instance", (file) => {
    const src = readFileSync(file, "utf8");
    // A lazy `useState` initializer or a `useRef` keeps the key stable across
    // renders and across repeated submits of the same form instance; a key
    // minted inside the submit handler would change on every attempt.
    const stableHolder =
      /useState\(\(\)\s*=>\s*new\w*IdempotencyKey\(\)\)/.test(src) ||
      /useRef<string>\(/.test(src);
    expect(stableHolder, `${file} must hold its idempotency key outside the submit handler`).toBe(true);
  });
});
