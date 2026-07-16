/**
 * ReturnFormatPreview — thin adapter that (1) derives the effective
 * submission format from template metadata, (2) builds the tabular
 * `SpreadsheetPreviewProps` for spreadsheet-family formats, and (3)
 * hands off to the shared `resolveReturnRenderer` descriptor.
 *
 * All renderer selection lives in `lib/preview/rendererRegistry` — this
 * component only prepares inputs and delegates.
 */
import {
  SpreadsheetPreviewColumn,
  type SpreadsheetPreviewProps,
} from "./SpreadsheetPreviewPane";
import {
  resolveReturnRenderer,
  type ReturnFormatKind,
} from "../../lib/preview/rendererRegistry";
import {
  SAMPLE_PAYROLL_ROWS,
  resolveSamplePath,
} from "../../lib/preview/samplePayload";

export type ReturnSubmissionFormatKind = ReturnFormatKind;
export interface ReturnSubmissionFormatSpec {
  kind?: ReturnSubmissionFormatKind;
  options?: Record<string, any>;
}

interface ReturnColumn {
  key: string;
  source: string;
  label?: string;
  format?: string;
  width?: number;
}

interface ReturnBodyLike {
  columns?: ReturnColumn[];
  totals?: string[];
  filters?: { rule_codes?: string[] };
  renderer?: string | null;
  sections?: unknown[];
}

interface Meta {
  legal_reference?: string | null;
  regulation_citation?: string | null;
  authority_name?: string | null;
  submission_format?: ReturnSubmissionFormatSpec | null;
}

interface Props {
  templateCode: string;
  displayName?: string | null;
  body: ReturnBodyLike;
  meta?: Meta | null;
  packId?: string | null;
}

function isNumericFormat(f?: string) {
  return f === "currency" || f === "number";
}

function buildSpreadsheetProps(
  body: ReturnBodyLike,
  meta: Meta | null | undefined,
  formatKind: ReturnFormatKind,
): SpreadsheetPreviewProps {
  const cols: SpreadsheetPreviewColumn[] = (body.columns ?? []).map((c) => ({
    header: c.label || c.key,
    token: c.source,
    numeric: isNumericFormat(c.format),
    width: c.width,
    format: c.format ?? null,
  }));
  const rows = SAMPLE_PAYROLL_ROWS.map((ctx) =>
    (body.columns ?? []).map((c) => {
      const v = resolveSamplePath(ctx, c.source);
      if (v === undefined || v === null) return "";
      return v as string | number;
    }),
  );

  const totals = new Set(body.totals ?? []);
  if (totals.size) {
    const totalRow = (body.columns ?? []).map((c, i) => {
      if (!totals.has(c.key)) return i === 0 ? "TOTAL" : "";
      const nums = rows.map((r) => r[i]).filter((v) => typeof v === "number") as number[];
      return nums.reduce((a, b) => a + b, 0);
    });
    rows.push(totalRow);
  }

  const opts = meta?.submission_format?.options ?? {};
  const delimiter =
    formatKind === "csv"
      ? typeof opts.delimiter === "string" ? opts.delimiter : ","
      : formatKind === "xlsx" ? "cell" : undefined;
  const encoding =
    typeof opts.encoding === "string" ? opts.encoding : formatKind === "csv" ? "utf-8" : undefined;
  const ext = formatKind === "csv" ? "csv" : formatKind === "xlsx" ? "xlsx" : undefined;

  const formatLabel =
    formatKind === "csv" ? "CSV — column export"
    : formatKind === "xlsx" ? "Excel workbook (.xlsx)"
    : formatKind === "xml" ? "XML payload"
    : formatKind === "json" ? "JSON payload"
    : undefined;

  return {
    title: "Live preview",
    formatLabel,
    columns: cols,
    rows,
    delimiter,
    encoding,
    fileExtension: ext,
    footnote:
      meta?.regulation_citation ||
      meta?.legal_reference ||
      "Sample rows — actual return uses live payroll figures.",
  };
}

export function ReturnFormatPreview({ templateCode, displayName, body, meta, packId }: Props) {
  const declared = meta?.submission_format?.kind ?? null;
  const hasV2 = body.renderer === "v2-returns" && Array.isArray(body.sections);
  // Declared format wins; otherwise the v2 flag forces PDF; otherwise a
  // template with just `columns[]` is a tabular CSV export — NOT a PDF.
  const formatKind: ReturnFormatKind = declared ?? (hasV2 ? "pdf" : "csv");

  const descriptor = resolveReturnRenderer(formatKind, { hasV2Sections: hasV2 });
  const spreadsheetProps =
    formatKind === "csv" || formatKind === "xlsx"
      ? buildSpreadsheetProps(body, meta, formatKind)
      : undefined;

  return descriptor.render({
    templateCode,
    displayName,
    body,
    meta,
    packId,
    spreadsheetProps,
  });
}

export default ReturnFormatPreview;
