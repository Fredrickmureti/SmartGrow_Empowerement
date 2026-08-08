/**
 * Architecture guard — scanner parity across transactional documents.
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

/**
 * Purchasing documents author lines exactly like their selling counterparts,
 * so they are held to the same contract. Requisitions are deliberately absent:
 * their lines are free-text demand with no `product_id`, so there is nothing
 * for a resolved scan to land on.
 */
const PURCHASE_FORMS = [
  "src/features/purchases/orders/PurchaseOrderCreatePage.tsx",
  "src/features/purchases/orders/PurchaseOrderEditPage.tsx",
  "src/features/purchases/rfqs/RFQCreatePage.tsx",
  "src/features/purchases/rfqs/RFQEditPage.tsx",
  "src/features/purchases/bills/BillCreatePage.tsx",
  "src/features/purchases/bills/BillEditPage.tsx",
  "src/features/purchases/returns/PurchaseReturnCreatePage.tsx",
  "src/features/purchases/returns/PurchaseReturnEditPage.tsx",
];

const ALL_FORMS = [...DOCUMENT_FORMS, ...PURCHASE_FORMS];

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Document scanner parity", () => {
  /**
   * The regression that started this guard was an export-name mismatch: the
   * file existed, every page imported it, and the whole workspace failed to
   * load. Text matching cannot see that, so the module is really imported.
   */
  it("DocumentLineScanner is exported under its own name", async () => {
    const mod = await import("@/components/documents/lines/DocumentLineScanner");
    expect(typeof mod.DocumentLineScanner).toBe("function");
    expect("InvoiceLineScanner" in mod).toBe(false);
  });

  it("the shared scan hooks are exported under their own names", async () => {
    const mod = await import("@/features/sales/scan-session/useDocumentLineScan");
    expect(typeof mod.useDocumentLineScan).toBe("function");
    expect(typeof mod.usePricedLineScan).toBe("function");
    expect(typeof mod.scanUnitPrice).toBe("function");
    expect(typeof mod.scanCostPrice).toBe("function");
  });

  it("the scan provider is exposed workspace-neutrally", async () => {
    const mod = await import("@/contexts/SalesScanContext");
    expect(typeof mod.DocumentScanProvider).toBe("function");
    expect(typeof mod.useDocumentScanController).toBe("function");
  });

  it("the Purchases workspace mounts the scan transport", () => {
    const src = read("src/apps/purchases/PurchasesLayout.tsx");
    expect(src).toMatch(/<DocumentScanProvider/);
    expect(src).toMatch(/workspace="purchases"/);
  });

  it.each(ALL_FORMS)("%s renders DocumentLineScanner", (path) => {
    const src = read(path);
    expect(src).toMatch(/<DocumentLineScanner/);
    expect(src).toMatch(
      /from "@\/components\/documents\/lines\/DocumentLineScanner"/,
    );
  });

  it.each(ALL_FORMS)("%s applies scans through the shared hook", (path) => {
    const src = read(path);
    expect(src).toMatch(/use(Priced|Document)LineScan/);
    // No bespoke merge loops — applyScanToLines is reached via the hook only.
    if (!path.includes("InvoiceCreatePage") && !path.includes("InvoiceEditPage")) {
      expect(src).not.toMatch(/applyScanToLines/);
    }
  });

  it.each(PURCHASE_FORMS)("%s prices scanned lines at cost, never selling price", (path) => {
    const src = read(path);
    expect(src).not.toMatch(/scanUnitPrice/);
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
