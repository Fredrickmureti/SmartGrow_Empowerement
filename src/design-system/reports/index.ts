/**
 * The canonical on-screen financial reporting engine.
 *
 * Report pages import from here and nowhere else for table, masthead and
 * number formatting. An architecture test forbids raw `<Table>` markup and
 * local currency formatters inside `src/pages/reports/`.
 */
export { ReportTable } from "./ReportTable";
export type { ReportTableProps } from "./ReportTable";
export { ReportSurface } from "./ReportSurface";
export type { ReportSurfaceProps, ReportFormatProfile } from "./ReportSurface";
export {
  STATEMENT_LINE_KINDS,
  STATEMENT_LINE_TREATMENT,
  TOTAL_LINE_KINDS,
  isTotalLineKind,
  resolveLineKind,
} from "./statementKinds";
export type { StatementLineKind, LineTreatment } from "./statementKinds";
export {
  EXPORT_KIND,
  buildSections,
  columnAlign,
  isNumericColumn,
  sumColumn,
  toExportColumns,
  toExportRows,
} from "./model";
export type {
  ReportCellValue,
  ReportColumn,
  ReportColumnGroup,
  ReportRow,
  ReportRowData,
  ReportRowKind,
  ReportRowMeta,
  SectionInput,
} from "./model";
export {
  EMPTY_CELL,
  blankIfZero,
  formatAccountingAmount,
  formatAccountingNumber,
  formatReportDate,
  formatReportNumber,
  formatReportPercent,
  formatReportValue,
  getCurrencySymbol,
} from "./format";
export type { ReportValueFormat } from "./format";
export { toReportColumns, toReportRows } from "./server";
export type { ServerReportColumn, ServerReportResult } from "./server";

