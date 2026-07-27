/**
 * Data-extract exports.
 *
 * Single import surface for tabular document exports (CSV / XLSX). See
 * `documentExport.ts` for why extracts are deliberately not part of the
 * document print pipeline.
 */
export {
  exportDocument,
  downloadExport,
  type ExportFormat,
  type ExportDocumentInput,
  type DownloadExportInput,
  type ExportResult,
} from "./documentExport";
