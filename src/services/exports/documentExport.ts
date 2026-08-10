/**
 * Document data export — CSV/XLSX extracts of a business document.
 *
 * ## An export is a *disposition*, not a second pipeline
 *
 * An earlier iteration treated extracts as a wholly separate concern that
 * re-read the database through the legacy `generate-document` endpoint.
 * That produced the classic ERP drift: the CSV a controller reconciles with
 * and the PDF the customer received were two independent reads of a moving
 * database, so an edit between them silently changed the numbers.
 *
 * Exports now converge on the same lifecycle as every other output:
 *
 *   business record → frozen snapshot (`document_records`)
 *     → rendering engine → medium (`pdf` | `escpos` | `zpl` | `csv` | `xlsx`)
 *     → archived artifact (`document_artifacts`)
 *
 * The `csv` and `xlsx` mediums project the SAME frozen snapshot the PDF was
 * drawn from, so an extract can no longer disagree with the printed,
 * emailed or archived copy of the document, and it lands in the same
 * version history.
 *
 * What remains true from before: an extract has no paper geometry, no
 * printer policy, no disposition routing and no physical device. It borrows
 * the render seam, not the print pipeline — nothing here may import from
 * `@/services/printing/printService` or the hardware layer.
 */
import { renderDocumentRecord } from "@/services/printing/render";
import { resolveSourceDocumentRecordId } from "@/services/documents/resolveSourceDocumentRecord";

/**
 * `pdf` is included deliberately: "Download PDF" is a DOWNLOAD disposition,
 * not a print job. Downloading must never dispatch to a physical printer —
 * it renders the same frozen snapshot and hands the bytes to the browser.
 */
export type ExportFormat = "csv" | "xlsx" | "pdf";

export interface ExportDocumentInput {
  /** Document type with a registered snapshot builder, e.g. `customer_statement`. */
  documentType: string;
  documentId: string;
  format: ExportFormat;
}

export interface DownloadExportInput extends ExportDocumentInput {
  /** Filename offered to the browser. Extension is appended when missing. */
  filename: string;
}

export interface ExportResult {
  success: boolean;
  error?: string;
}

const MIME: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Freeze the document (idempotently) and render the extract from its
 * snapshot.
 *
 * Document types without a registered snapshot builder throw rather than
 * silently degrading to a live re-read — a missing builder is an
 * architectural gap to close, not a runtime fallback.
 */
export async function exportDocument(input: ExportDocumentInput): Promise<Blob> {
  const documentRecordId = await resolveSourceDocumentRecordId(
    input.documentType,
    input.documentId,
  );
  const artifact = await renderDocumentRecord({
    documentRecordId,
    medium: input.format,
  });
  const type = artifact.mimeType || MIME[input.format];
  return new Blob([artifact.bytes as unknown as BlobPart], { type });
}

/** Ensure the filename carries the extension matching the chosen format. */
function withExtension(filename: string, format: ExportFormat): string {
  const suffix = `.${format}`;
  return filename.toLowerCase().endsWith(suffix) ? filename : `${filename}${suffix}`;
}

/**
 * Fetch an extract and hand it to the browser as a download.
 *
 * Never throws — callers get a structured result so a failed export surfaces
 * as an operator-facing message instead of an unhandled rejection inside a
 * menu-item click handler.
 */
export async function downloadExport(
  input: DownloadExportInput,
): Promise<ExportResult> {
  let url: string | null = null;
  try {
    const blob = await exportDocument(input);
    url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = withExtension(input.filename, input.format);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
