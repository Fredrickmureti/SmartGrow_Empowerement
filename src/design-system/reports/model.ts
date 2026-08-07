/**
 * Column + row model for the canonical report table.
 *
 * A report page declares WHAT it is showing (columns, typed rows); the
 * engine decides HOW it looks — alignment, tabular figures, indentation,
 * section banding, subtotal and grand-total treatment, sticky behaviour.
 * This is the on-screen twin of the `ExportColumn` / `ExportRow` contract
 * the PDF engine already uses, and `toExportColumns()` converts one into
 * the other so a column can never exist in the PDF but not on screen.
 */
import type { ReportValueFormat } from "./format";
import type { ExportColumn, ExportRow } from "@/services/reports/ReportExportService";

export interface ReportColumn<Row = ReportRow> {
  /** Key into the row's `values` map. */
  key: string;
  header: string;
  /** Drives alignment, tabular figures and cell formatting. */
  format?: ReportValueFormat;
  /** Overrides the alignment implied by `format`. */
  align?: "left" | "center" | "right";
  /** Tailwind width class, e.g. "w-[110px]". */
  width?: string;
  /** Pin this column while the table scrolls horizontally. */
  sticky?: boolean;
  /** Draw a group rule on the right edge of this column. */
  groupEnd?: boolean;
  /** Hide below the `md` breakpoint — for low-priority columns. */
  secondary?: boolean;
  /**
   * Custom cell renderer; bypasses formatting for this column only.
   * Receives the whole row, so a renderer can read sibling values
   * (`row.values.status`) as well as the row's kind and tone.
   */
  render?: (row: Row) => React.ReactNode;
  /** Exclude from exported PDF/CSV/XLSX (e.g. an actions column). */
  exportExclude?: boolean;
}

/** A header tier above the columns, e.g. Opening / Movement / Closing. */
export interface ReportColumnGroup {
  label: string;
  /** Number of leaf columns this group spans. */
  span: number;
  align?: "left" | "center" | "right";
}

export type ReportRowKind =
  | "detail"
  | "section"
  | "subtotal"
  | "grandTotal"
  | "spacer";

export type ReportCellValue = string | number | boolean | null | undefined;
export type ReportRowData = Record<string, ReportCellValue>;

export interface ReportRow {
  id: string;
  kind?: ReportRowKind;
  /** Indent level for hierarchical charts of accounts. */
  depth?: number;
  /** Section / subtotal label, rendered in the first column span. */
  label?: string;
  values?: ReportRowData;
  onClick?: () => void;
  /** Flags the row as an exception (out of balance, overdue, …). */
  tone?: "default" | "warning" | "danger" | "success";
}

const NUMERIC_FORMATS = new Set<ReportValueFormat>([
  "currency",
  "amount",
  "number",
  "percent",
]);

export function isNumericColumn(col: ReportColumn<never>): boolean {
  return !!col.format && NUMERIC_FORMATS.has(col.format);
}

export function columnAlign(col: ReportColumn<never>): "left" | "center" | "right" {
  return col.align ?? (isNumericColumn(col) ? "right" : "left");
}

/**
 * Derive the export column spec from the on-screen spec so the two are one
 * declaration. `amount` collapses to `currency` — the PDF engine has no
 * symbol-less accounting format.
 */
export function toExportColumns(columns: ReportColumn<never>[]): ExportColumn[] {
  return columns
    .filter((c) => !c.exportExclude)
    .map((c) => ({
      key: c.key,
      header: c.header,
      format:
        c.format === "amount"
          ? ("currency" as const)
          : c.format === "date"
            ? ("date" as const)
            : c.format === "currency" || c.format === "number" || c.format === "percent"
              ? c.format
              : ("text" as const),
      align: columnAlign(c),
    }));
}

/**
 * Derive export rows from the same row model that drives the screen, so
 * section / subtotal / grand-total hierarchy survives into the PDF via the
 * `_isHeader` / `_isSubtotal` / `_isGrandTotal` flags the engine expects.
 */
export function toExportRows(
  rows: ReportRow[],
  columns: ReportColumn<never>[],
): ExportRow[] {
  const firstKey = columns[0]?.key ?? "label";
  return rows
    .filter((r) => r.kind !== "spacer")
    .map((r) => {
      const base: ExportRow = { ...(r.values ?? {}) };
      if (r.label != null && base[firstKey] == null) base[firstKey] = r.label;
      if (r.kind === "section") base._isHeader = true;
      if (r.kind === "subtotal") base._isSubtotal = true;
      if (r.kind === "grandTotal") base._isGrandTotal = true;
      if (r.depth) base._depth = r.depth;
      return base;
    });
}

/** Sum a numeric column across detail rows — subtotals derived once. */
export function sumColumn(rows: ReportRow[], key: string): number {
  let total = 0;
  for (const r of rows) {
    if (r.kind && r.kind !== "detail") continue;
    const v = r.values?.[key];
    if (typeof v === "number" && !Number.isNaN(v)) total += v;
  }
  return total;
}

export interface SectionInput {
  id: string;
  label: string;
  rows: ReportRow[];
  /** Numeric column keys to subtotal. Defaults to every numeric column. */
  subtotalKeys?: string[];
  subtotalLabel?: string;
}

/**
 * Build the canonical section → details → subtotal sequence, with totals
 * computed once here rather than recomputed inside render.
 */
export function buildSections(
  sections: SectionInput[],
  columns: ReportColumn<never>[],
  options: { grandTotalLabel?: string; includeGrandTotal?: boolean } = {},
): ReportRow[] {
  const numericKeys = columns.filter((c) => isNumericColumn(c)).map((c) => c.key);
  const out: ReportRow[] = [];
  const grand: Record<string, number> = {};

  for (const section of sections) {
    if (section.rows.length === 0) continue;
    out.push({ id: `sec-${section.id}`, kind: "section", label: section.label });
    out.push(...section.rows);

    const keys = section.subtotalKeys ?? numericKeys;
    const values: ReportRowData = {};
    for (const key of keys) {
      const total = sumColumn(section.rows, key);
      values[key] = total;
      grand[key] = (grand[key] ?? 0) + total;
    }
    out.push({
      id: `sub-${section.id}`,
      kind: "subtotal",
      label: section.subtotalLabel ?? `${section.label} total`,
      values,
    });
  }

  if (options.includeGrandTotal !== false && out.length > 0) {
    out.push({
      id: "grand-total",
      kind: "grandTotal",
      label: options.grandTotalLabel ?? "Total",
      values: grand,
    });
  }

  return out;
}
