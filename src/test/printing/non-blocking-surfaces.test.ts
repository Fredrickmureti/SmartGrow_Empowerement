/**
 * Phase 5 guardrail — document surfaces must not await the printer.
 *
 * The blocking entries (`printDocumentIntent`, `printSourceDocumentIntent`)
 * remain in `PrintService` for background jobs and tests, but a UI surface
 * that awaits them puts render + device resolve + printer socket on the
 * operator's clock — the exact 5–18s freeze Phase 5 removed. Surfaces go
 * through `services/printing/acknowledge` (or `usePrintDispatch`) instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SURFACES = [
  "src/pages/Invoices.tsx",
  "src/pages/Estimates.tsx",
  "src/pages/DeliveryNotes.tsx",
  "src/pages/CustomerStatements.tsx",
  "src/pages/CustomerPayments.tsx",
  "src/pages/CreditNotes.tsx",
  "src/pages/Bills.tsx",
  "src/pages/PurchaseReturns.tsx",
  "src/pages/PurchaseOrders.tsx",
  "src/pages/SalesReturns.tsx",
  "src/pages/ProformaInvoices.tsx",
  "src/pages/SalesOrders.tsx",
  "src/features/sales/record/useRecordPrint.ts",
  "src/components/pos/restaurant/KitchenOrderTicket.tsx",
];

describe("Phase 5 non-blocking surfaces", () => {
  it.each(SURFACES)("%s does not await a blocking print entry", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/await\s+printDocumentIntent\s*\(/);
    expect(src).not.toMatch(/await\s+printSourceDocumentIntent\s*\(/);
  });

  it.each(SURFACES)("%s acknowledges through the shared seam", (file) => {
    const src = readFileSync(file, "utf8");
    expect(
      /acknowledgeRecordPrint|acknowledgeSourcePrint|usePrintDispatch|startPrint/.test(src),
    ).toBe(true);
  });
});
