/**
 * Guardrail: procurement documents must never render as invoices.
 *
 * Regression origin (2026-08-10): RFQ-0002 and PR-2026-0001 shipped to paper
 * with "Bill To", price/tax/amount columns, "Total KES NaN" and
 * "Thank you for your business!" — the sales-invoice layout leaking into the
 * solicitation/requisition path. An RFQ asks for a price; it must never state
 * one, and an internal requisition is not a customer-facing bill.
 *
 * This test renders both layouts and asserts the banned vocabulary never
 * appears in the emitted PDF content streams, plus that no numeric formatter
 * can leak `NaN` onto a document.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateSolicitationPdf, generateRequisitionPdf } from "../layouts/procurement.ts";
import { formatAccountingNumber, formatAmount } from "../../format/currency.ts";

const ORG = { name: "Guardrail Ltd", country: "KE" } as never;

/** Words that only belong on a priced, customer-facing sales document. */
const BANNED = [
  "Bill To",
  "BILL TO",
  "Thank you for your business",
  "Amount Due",
  "Balance Due",
  "NaN",
  "undefined",
  "Infinity",
];

/**
 * pdf-lib writes text as literal strings inside (possibly compressed) content
 * streams. The layouts under test emit uncompressed streams, so a latin1 scan
 * of the bytes is a faithful full-text check.
 */
function pdfText(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function assertNoInvoiceVocabulary(label: string, bytes: Uint8Array) {
  const text = pdfText(bytes);
  for (const banned of BANNED) {
    assert(
      !text.includes(banned),
      `${label}: procurement document must not contain "${banned}"`,
    );
  }
}

Deno.test("RFQ renders as a solicitation, never as an invoice", async () => {
  const bytes = await generateSolicitationPdf(
    {
      document_type: "rfq",
      document_type_label: "REQUEST FOR QUOTATION",
      document_number: "RFQ-TEST-1",
      revision: 1,
      issue_date: "2026-08-10",
      currency: "KES",
      status: "draft",
      business_name: "Guardrail Ltd",
      items: [
        { sku: "SKU-1", description: "Widget", quantity: 3 },
        { sku: "SKU-2", description: "Gadget", quantity: 1 },
      ],
      response_instructions: "Quote unit price, lead time and validity.",
    } as never,
    ORG,
    { paperFormat: "a4" } as never,
  );
  assert(bytes.length > 0, "solicitation produced no bytes");
  assertNoInvoiceVocabulary("RFQ", bytes);
});

Deno.test("Purchase requisition renders as an internal request, never as an invoice", async () => {
  const bytes = await generateRequisitionPdf(
    {
      document_type: "requisition",
      document_type_label: "PURCHASE REQUISITION",
      document_number: "PR-TEST-1",
      revision: 1,
      issue_date: "2026-08-10",
      currency: "KES",
      status: "approved",
      business_name: "Guardrail Ltd",
      items: [{ sku: "SKU-1", description: "Widget", quantity: 2 }],
    } as never,
    ORG,
    { paperFormat: "a4" } as never,
  );
  assert(bytes.length > 0, "requisition produced no bytes");
  assertNoInvoiceVocabulary("Requisition", bytes);
});

Deno.test("money formatters never emit NaN/Infinity onto a document", () => {
  const garbage = [NaN, Infinity, -Infinity, undefined, null, "abc"];
  for (const value of garbage) {
    const accounting = formatAccountingNumber(value as never, "KES");
    const plain = formatAmount(value as never);
    assert(
      accounting === "KES 0.00",
      `formatAccountingNumber(${String(value)}) => ${accounting}`,
    );
    assert(plain === "0.00", `formatAmount(${String(value)}) => ${plain}`);
  }
});
