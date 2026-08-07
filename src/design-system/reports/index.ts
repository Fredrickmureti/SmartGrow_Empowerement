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
