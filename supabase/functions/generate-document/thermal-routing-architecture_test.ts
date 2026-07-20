/**
 * Architecture guards — thermal PDF ownership.
 *
 * The platform must never produce 40/58/80mm ERP PDFs by squeezing the A4
 * coordinate renderer. `generate-document` owns routing; thermal PDFs flow
 * through the receipt line engine + renderThermalPdf, and email attachments
 * must call that same router instead of rebuilding DocumentData locally.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import { renderThermalPdf } from "../_shared/receipt/pdf/renderThermalPdf.ts";
import { generateDocumentPdf } from "../_shared/pdfGenerator.ts";
import type { ReceiptLinesResult } from "../_shared/receipt/lines.ts";

const generateDocumentSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const emailSource = await Deno.readTextFile(
  new URL("../send-document-email/index.ts", import.meta.url),
);
const pdfGeneratorSource = await Deno.readTextFile(
  new URL("../_shared/pdfGenerator.ts", import.meta.url),
);

Deno.test("generate-document routes thermal PDFs through the receipt engine before the A4 renderer", () => {
  assertStringIncludes(generateDocumentSource, "routeThroughThermalEngine");
  assertStringIncludes(generateDocumentSource, "documentType === \"pos_receipt\"");
  assertStringIncludes(generateDocumentSource, "renderThermalPdf(rows)");
  assertStringIncludes(generateDocumentSource, "X-Print-Policy-Renderer");
  assertStringIncludes(generateDocumentSource, "thermal-engine");

  const routeIdx = generateDocumentSource.indexOf("routeThroughThermalEngine");
  const engineIdx = generateDocumentSource.indexOf("renderThermalPdf(rows)");
  const legacyIdx = generateDocumentSource.indexOf("generateDocumentPdf(documentData");
  assert(routeIdx > 0, "thermal route gate must exist");
  assert(engineIdx > routeIdx, "thermal renderer must be inside/after the route gate");
  assert(
    legacyIdx > engineIdx,
    "A4 renderer must remain behind the thermal route gate, not before it",
  );
});

Deno.test("send-document-email does not directly call the A4 ERP PDF renderer", () => {
  assert(
    !emailSource.includes("../_shared/pdfGenerator.ts"),
    "email attachments must not import the legacy/A4 pdfGenerator module",
  );
  assert(
    !/\bgenerateDocumentPdf\s*\(/.test(emailSource),
    "email attachments must call generate-document, not generateDocumentPdf directly",
  );
  assertStringIncludes(emailSource, "/functions/v1/generate-document");
});

Deno.test("generateDocumentPdf self-defends against receipt-like thermal documents", async () => {
  assertStringIncludes(pdfGeneratorSource, "pos_receipt_settings?.paper_size");
  assertStringIncludes(pdfGeneratorSource, "gpg_docType === \"pos_receipt\"");
  assertStringIncludes(pdfGeneratorSource, "gpg_docType === \"receipt\"");

  await assertRejects(
    () => generateDocumentPdf({
      document_number: "POS-TEST-0001",
      document_type: "pos_receipt" as any,
      status: "completed",
      issue_date: new Date().toISOString(),
      subtotal: 10,
      tax_amount: 0,
      discount_amount: 0,
      total: 10,
      amount_paid: 10,
      currency: "KES",
      notes: null,
      terms: null,
      contact: null,
      organization: { name: "Test Store" } as any,
      items: [],
      pos_receipt_settings: { paper_size: "80mm" },
    } as any),
    Error,
    "generateDocumentPdf refused: document is thermal",
  );
});

Deno.test("renderThermalPdf emits receipt-width continuous-roll pages, not A4-height pages", async () => {
  const result: ReceiptLinesResult = {
    paper: "80mm",
    columns: 48,
    marginCols: 0,
    font: "A",
    lines: [
      "TEST STORE",
      "SALES RECEIPT",
      "No: POS-TEST-0001",
      "Date: 2026-07-20",
      "----------------------------------------",
      "Coffee                         KES 10.00",
      "TOTAL                          KES 10.00",
      "Cash                           KES 10.00",
      "----------------------------------------",
      "Thank you",
    ],
    meta: [
      { align: "center", bold: true },
      { align: "center", bold: true },
      { align: "left" },
      { align: "left" },
      { align: "left", rule: true },
      { align: "left" },
      { align: "left", bold: true },
      { align: "left" },
      { align: "left", rule: true },
      { align: "center" },
    ],
  };

  const bytes = await renderThermalPdf(result);
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(0);
  const { width, height } = page.getSize();
  const byteText = new TextDecoder("latin1").decode(bytes);

  assertEquals(pdf.getPageCount(), 1);
  assert(Math.abs(width - 226.772) < 1, `80mm width expected, got ${width}`);
  assert(height < 500, `thermal roll height expected under 500pt, got ${height}`);
  assert(Math.abs(height - 841.89) > 100, "thermal receipt must not be A4 height");
  assert(!byteText.includes("Report generated:"), "thermal renderer must not include A4 report footer");
});
