/**
 * Document data export — the canonical owner of tabular extracts.
 *
 * ## Why this is not part of the print pipeline
 *
 * A CSV/XLSX extract is *data*, not a rendered document. It has no paper
 * geometry, no template, no printer policy, no disposition routing, and no
 * physical device at the end of it. Routing it through the print client
 * conflated two responsibilities that mature ERPs keep apart:
 *
 *   document → template → render → policy → printer → transport → device
 *   dataset  → serialiser → download
 *
 * The only thing the two paths legitimately share is the *archive*: the edge
 * function persists an immutable `document_artifacts` row with
 * `render_mode: 'export'`, so the extract shows up in the same version
 * history as the PDF and ESC/POS renders of the same document. That is an
 * archival concern, not a printing one.
 *
 * Everything a caller needs lives here. Nothing in this module may import
 * from `@/services/printing/**`, and nothing in the print pipeline may
 * import from here.
 */
import { supabase } from "@/integrations/supabase/client";

export type ExportFormat = "csv" | "xlsx";

export interface ExportDocumentInput {
  /** Server-side allow-listed document type, e.g. `customer_statement`. */
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
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Fetch a server-rendered extract as a Blob.
 *
 * Only document types on the server-side allow-list are accepted; anything
 * else fails at the edge with a 400 rather than silently degrading to an
 * empty file.
 */
export async function exportDocument(input: ExportDocumentInput): Promise<Blob> {
  const { data, error } = await supabase.functions.invoke("generate-document", {
    body: {
      documentType: input.documentType,
      documentId: input.documentId,
      format: input.format,
    },
  });
  if (error) throw error;

  const type = MIME[input.format];
  if (data instanceof Blob) return data;
  if (data instanceof Uint8Array) return new Blob([data as BlobPart], { type });
  if (data instanceof ArrayBuffer) return new Blob([data], { type });
  // supabase-js returns a string for text responses.
  if (typeof data === "string") return new Blob([data], { type });
  return new Blob([data as BlobPart], { type });
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
