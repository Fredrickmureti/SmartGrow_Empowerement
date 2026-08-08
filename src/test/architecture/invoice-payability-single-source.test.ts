/**
 * Payability is derived from a residual balance, never from a status label.
 *
 * Ratchet: the Receive Payment surfaces must not reintroduce hand-written
 * invoice-status arrays as payability gates. `confirmed` vs `sent` drift is
 * exactly how a real receivable became invisible to the payment flow.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const PAYABILITY = readFileSync("src/services/finance/invoicePayability.ts", "utf8");
const SALES_DIALOG = readFileSync("src/components/sales/RecordPaymentDialog.tsx", "utf8");
const INVOICE_LIST = readFileSync("src/components/invoices/InvoiceListTable.tsx", "utf8");
const CONFIRM_GL = readFileSync("src/hooks/invoices/confirmInvoiceGL.ts", "utf8");
const PAGINATED = readFileSync("src/hooks/useInvoicesPaginated.ts", "utf8");

/** e.g. ["sent", "partial", "overdue"] used as a payability gate. */
const STATUS_ARRAY = /\[\s*"(?:sent|viewed|partial|overdue|confirmed)"(?:\s*,\s*"[a-z_]+")*\s*\]/;

describe("invoice payability single source", () => {
  it("exposes a residual-based predicate and a projection-backed fetcher", () => {
    expect(PAYABILITY).toContain("export function isInvoicePayable");
    expect(PAYABILITY).toContain("export function isInvoiceOverdue");
    expect(PAYABILITY).toContain("finance_ar_open_items");
    expect(PAYABILITY).toContain("NON_PAYABLE_INVOICE_STATUSES");
  });

  it("keeps the customer payment picker on the GL-gated AR projection", () => {
    expect(SALES_DIALOG).toContain("fetchOpenCustomerInvoices");
    expect(SALES_DIALOG).not.toMatch(/\.in\("status",/);
    expect(SALES_DIALOG).not.toMatch(STATUS_ARRAY);
  });

  it("gates the Record Payment row action on the shared predicate", () => {
    expect(INVOICE_LIST).toContain("isInvoicePayable(invoice)");
    expect(INVOICE_LIST).toContain("isInvoiceOverdue(invoice)");
    expect(INVOICE_LIST).not.toMatch(STATUS_ARRAY);
  });

  it("keeps the confirm RPC the single writer of the post-confirm status", () => {
    expect(CONFIRM_GL).toContain('p_final_status: "sent"');
    expect(PAGINATED).not.toMatch(/update\(\{\s*status:\s*"sent"/);
  });
});
