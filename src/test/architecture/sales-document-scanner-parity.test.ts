/**
 * Architecture guard — scanner parity across Sales documents.
 *
 * Regression motivation: the Sales workspace mounts `SalesScanProvider`, so a
 * paired phone / USB wedge / camera is live on EVERY sales page, but for a long
 * time only the Invoice form consumed it. Operators on Estimates, Proforma,
 * Sales Orders, Credit Notes, Returns and Delivery Notes got a scanner that
 * appeared to work and silently did nothing.
 *
 * Every line-capturing Sales document form must therefore render
 * `DocumentLineScanner` and apply scans through `useDocumentLineScan`
 * (directly or via `usePricedLineScan`) — never a bespoke re-implementation of
 * the scan→line merge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const DOCUMENT_FORMS = [
  "src/features/sales/estimates/EstimateCreatePage.tsx",
  "src/features/sales/estimates/EstimateEditPage.tsx",
  "src/features/sales/proforma/ProformaCreatePage.tsx",
  "src/features/sales/orders/SalesOrderCreatePage.tsx",
  "src/features/sales/orders/SalesOrderEditPage.tsx",
  "src/features/sales/invoices/InvoiceCreatePage.tsx",
  "src/features/sales/invoices/InvoiceEditPage.tsx",
  "src/features/sales/credit-notes/CreditNoteCreatePage.tsx",
  "src/features/sales/credit-notes/CreditNoteEditPage.tsx",
  "src/features/sales/returns/SalesReturnCreatePage.tsx",
  "src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx",
];

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Sales document scanner parity", () => {
  it.each(DOCUMENT_FORMS)("%s renders DocumentLineScanner", (path) => {
    const src = read(path);
    expect(src).toMatch(/<DocumentLineScanner/);
    expect(src).toMatch(
      /from "@\/components\/documents\/lines\/DocumentLineScanner"/,
    );
  });

  it.each(DOCUMENT_FORMS)("%s applies scans through the shared hook", (path) => {
    const src = read(path);
    expect(src).toMatch(/use(Priced|Document)LineScan/);
    // No bespoke merge loops — applyScanToLines is reached via the hook only.
    if (!path.includes("InvoiceCreatePage") && !path.includes("InvoiceEditPage")) {
      expect(src).not.toMatch(/applyScanToLines/);
    }
  });

  it("the scanner is generic — no invoice-only scanner component remains", () => {
    expect(() => read("src/components/invoices/InvoiceLineScanner.tsx")).toThrow();
  });

  it("delivery notes scan in verify mode (fulfilment, not authoring)", () => {
    const src = read("src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx");
    expect(src).toMatch(/mode="verify"/);
    // Over-delivery must be refused rather than silently clamped.
    expect(src).toMatch(/return null/);
  });
});
