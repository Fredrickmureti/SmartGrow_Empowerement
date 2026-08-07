/**
 * server.ts — adapter from a `render-report` JSON result to the on-screen
 * report model.
 *
 * `render-report` with `format: "json"` returns the SAME column spec the
 * PDF renderer uses (`{ key, header, format, align }`) plus raw `data`
 * rows. Before this adapter, every module that wanted an on-screen table
 * from a server-built report either hand-rolled its own `<Table>` markup
 * (payroll) or skipped the screen entirely and only offered a PDF preview
 * (projects). Both drift from the archived PDF.
 *
 * With this adapter a page does:
 *
 *   const columns = toReportColumns(result.columns);
 *   const rows    = toReportRows(result.data, columns);
 *   <ReportTable columns={columns} rows={rows} currency={currency} />
 *
 * and the screen is, by construction, the same document as the export.
 */
import type { ReportValueFormat } from "./format";
import type { ReportColumn, ReportRow, ReportRowData } from "./model";

export interface ServerReportColumn {
  key: string;
  header: string;
  format?: string | null;
  align?: string | null;
  width?: string | null;
}

export interface ServerReportResult {
  columns?: ServerReportColumn[] | null;
  data?: Record<string, unknown>[] | null;
  /** Optional server-provided title / period metadata. */
  reportType?: string;
  dateRange?: { from?: string; to?: string };
}

const VALUE_FORMATS: ReadonlySet<string> = new Set([
  "text",
  "currency",
  "amount",
  "number",
  "percent",
  "date",
]);

function toValueFormat(format?: string | null): ReportValueFormat {
  if (format && VALUE_FORMATS.has(format)) return format as ReportValueFormat;
  return "text";
}

function toAlign(align?: string | null): ReportColumn["align"] | undefined {
  return align === "left" || align === "center" || align === "right" ? align : undefined;
}

/** Column spec → on-screen column spec. First column sticks for wide reports. */
export function toReportColumns(
  columns?: ServerReportColumn[] | null,
): ReportColumn<never>[] {
  const list = columns ?? [];
  return list.map((c, i) => ({
    key: c.key,
    header: c.header,
    format: toValueFormat(c.format),
    align: toAlign(c.align),
    sticky: i === 0 && list.length > 6,
  }));
}

/**
 * Raw server rows → report rows. Honours the same hierarchy flags the PDF
 * engine reads (`_isHeader`, `_isSubtotal`, `_isGrandTotal`, `_depth`), so
 * a report with sections renders with sections on screen too.
 */
export function toReportRows(
  data: Record<string, unknown>[] | null | undefined,
  columns: ReportColumn<never>[],
  options?: { onRowClick?: (row: Record<string, unknown>) => void },
): ReportRow[] {
  const rows = data ?? [];
  const firstKey = columns[0]?.key;
  return rows.map((raw, index) => {
    const values: ReportRowData = {};
    for (const col of columns) {
      const v = raw[col.key];
      values[col.key] =
        v === null || v === undefined
          ? null
          : typeof v === "number" || typeof v === "boolean"
            ? v
            : String(v);
    }
    const kind: ReportRow["kind"] = raw._isGrandTotal
      ? "grandTotal"
      : raw._isSubtotal
        ? "subtotal"
        : raw._isHeader
          ? "section"
          : "detail";
    const label =
      kind !== "detail" && firstKey ? (values[firstKey] as string | null) ?? undefined : undefined;
    return {
      id: String(raw.id ?? `${index}`),
      kind,
      depth: typeof raw._depth === "number" ? raw._depth : undefined,
      label,
      values,
      onClick: options?.onRowClick ? () => options.onRowClick!(raw) : undefined,
    };
  });
}
