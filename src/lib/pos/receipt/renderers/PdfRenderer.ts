/**
 * Stage X2 — PDF receipt renderer.
 *
 * Thin wrapper around the unified server engine. Returns a Blob the
 * orchestrator can hand to `printPdfInPage` or `downloadPdfBlob`.
 */
import { generateDocumentPdf } from "@/services/printing/pdfUtils";
import type { ReceiptDocumentModel } from "../ReceiptDocumentModel";

export async function renderReceiptPdf(
  model: ReceiptDocumentModel,
): Promise<Blob> {
  return generateDocumentPdf("pos_receipt", model.meta.transaction_id);
}