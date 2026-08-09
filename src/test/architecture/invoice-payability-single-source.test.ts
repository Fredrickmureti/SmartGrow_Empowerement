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
const SALES_DIALOG = readFileSync("src/components/payments/RecordCustomerPaymentDialog.tsx", "utf8");
const INVOICE_LIST = readFileSync("src/components/invoices/InvoiceListTable.tsx", "utf8");
const CONFIRM_GL = readFileSync("src/hooks/invoices/confirmInvoiceGL.ts", "utf8");
const PAGINATED = readFileSync("src/hooks/useInvoicesPaginated.ts", "utf8");
const CONTACT_AGING = readFileSync("src/components/contacts/ContactAgingBreakdown.tsx", "utf8");
const CONTACT_DRAWER = readFileSync("src/components/contacts/ContactPreviewDrawer.tsx", "utf8");
const MGMT_REPORT = readFileSync("src/pages/reports/ManagementReports.tsx", "utf8");
const OPEN_ITEMS = readFileSync("src/services/finance/openItems.ts", "utf8");

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

  it("derives contact and management receivables from the open-item projections", () => {
    expect(OPEN_ITEMS).toContain("export async function fetchContactOpenItemAging");

    for (const src of [CONTACT_AGING, CONTACT_DRAWER]) {
      expect(src).toContain("fetchContactOpenItemAging");
    }
    expect(CONTACT_AGING).not.toMatch(STATUS_ARRAY);
    expect(CONTACT_DRAWER).not.toMatch(STATUS_ARRAY);

    expect(MGMT_REPORT).toContain("fetchARSummary");
    expect(MGMT_REPORT).toContain("fetchAPSummary");
    // No hand-summed receivable/payable from document status labels.
    expect(MGMT_REPORT).not.toMatch(/totalReceivables = validInvoices/);
    expect(MGMT_REPORT).not.toMatch(/totalPayables = bills/);
  });

  it("keeps the confirm RPC the single writer of the post-confirm status", () => {
    expect(CONFIRM_GL).toContain('p_final_status: "sent"');
    expect(PAGINATED).not.toMatch(/update\(\{\s*status:\s*"sent"/);
  });
});
