// @ts-nocheck — Deno runtime
/**
 * govFileWriter — declarative writer for government-portal-import files
 * (KRA iTax bulk CSV, URA PAYE CSV, SARS EMP201 templates, KRA P10 XML, etc.).
 *
 * Driven exclusively by `localization_pack_return_templates.submission_format`
 * — NO country branches in code. Adding a new authority = pack INSERT.
 *
 * Supported `type` values: `gov_csv` (built-in CSV writer below),
 * `gov_xlsx` (delegated to `xlsxWriter.ts`), `gov_xml` (delegated to
 * `xmlWriter.ts`). All three share the same row context produced by the
 * statutory-return generator.
 */
import { writeXlsx, XLSX_CONTENT_TYPE } from "./xlsxWriter.ts";
import { renderGovXml, XML_CONTENT_TYPE, type XmlSubmissionFormat } from "./xmlWriter.ts";
import { readSource as resolveSource, type SourceContext } from "./returnSourceResolver.ts";

export interface GovFileColumn {
  header: string;
  source: string;
  format?: "fixed2" | "int" | "raw";
}

export interface GovFileTrailer {
  label?: string;
  columns?: string[];
}

export interface GovFileSubmissionFormat {
  type?: "gov_csv" | "gov_xlsx" | "gov_xml";
  delimiter?: string;
  encoding?: string;
  include_header?: boolean;
  columns?: GovFileColumn[];
  trailer?: GovFileTrailer;
}

export type GovFileRowContext = SourceContext;

function csvEscape(v: unknown, delim: string): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const re = new RegExp(`["\\n\\r${delim.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}]`);
  if (re.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function readSource(source: string, ctx: GovFileRowContext): unknown {
  return resolveSource(source, ctx);
}

function applyFormat(v: unknown, fmt?: string): string {
  if (fmt === "fixed2") return (Number(v) || 0).toFixed(2);
  if (fmt === "int")    return String(Math.trunc(Number(v) || 0));
  return v === null || v === undefined ? "" : String(v);
}

export interface GovFileOutput {
  bytes: Uint8Array;
  extension: string;
  contentType: string;
}

/**
 * Render a government-portal-import file from a declarative submission_format
 * descriptor. Returns null when the descriptor is absent or empty (generator
 * skips upload).
 */
export async function renderGovFile(
  fmt: GovFileSubmissionFormat | null | undefined,
  rows: GovFileRowContext[],
): Promise<GovFileOutput | null> {
  if (!fmt || typeof fmt !== "object") return null;
  const type = fmt.type ?? "gov_csv";

  // ---- gov_xlsx --------------------------------------------------------
  if (type === "gov_xlsx") {
    const columns = Array.isArray(fmt.columns) ? fmt.columns : [];
    if (!columns.length) return null;
    const headers = columns.map((c) => c.header);
    const grid = rows.map((ctx) =>
      columns.map((c) => {
        const raw = readSource(c.source, ctx);
        if (c.format === "fixed2") return Number(raw) || 0;
        if (c.format === "int") return Math.trunc(Number(raw) || 0);
        return raw as string;
      })
    );
    const bytes = await writeXlsx({ name: "Sheet1", headers, rows: grid });
    return { bytes, extension: "gov.xlsx", contentType: XLSX_CONTENT_TYPE };
  }

  // ---- gov_xml ---------------------------------------------------------
  if (type === "gov_xml") {
    const bytes = renderGovXml(fmt as unknown as XmlSubmissionFormat, rows);
    return { bytes, extension: "gov.xml", contentType: XML_CONTENT_TYPE };
  }

  if (type !== "gov_csv") {
    throw new Error(`GOV_FORMAT_UNKNOWN: ${type}`);
  }
  const columns = Array.isArray(fmt.columns) ? fmt.columns : [];
  if (!columns.length) return null;

  const delim = typeof fmt.delimiter === "string" && fmt.delimiter.length === 1 ? fmt.delimiter : ",";
  const includeHeader = fmt.include_header !== false;

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(columns.map((c) => csvEscape(c.header, delim)).join(delim));
  }

  // Track trailer totals
  const trailerTotals: Record<string, number> = {};
  const trailerCols = new Set(fmt.trailer?.columns ?? []);

  for (const ctx of rows) {
    const cells: string[] = [];
    for (const col of columns) {
      const raw = readSource(col.source, ctx);
      const cell = applyFormat(raw, col.format);
      cells.push(csvEscape(cell, delim));
      if (trailerCols.has(col.header)) {
        trailerTotals[col.header] = (trailerTotals[col.header] ?? 0) + (Number(raw) || 0);
      }
    }
    lines.push(cells.join(delim));
  }

  if (fmt.trailer && trailerCols.size) {
    const labelCol = columns[0]?.header ?? "";
    const cells: string[] = [];
    for (const col of columns) {
      if (col.header === labelCol) {
        cells.push(csvEscape(fmt.trailer.label ?? "TOTAL", delim));
      } else if (trailerCols.has(col.header)) {
        cells.push(csvEscape((trailerTotals[col.header] ?? 0).toFixed(2), delim));
      } else {
        cells.push("");
      }
    }
    lines.push(cells.join(delim));
  }

  const text = lines.join("\n");
  return {
    bytes: new TextEncoder().encode(text),
    extension: "gov.csv",
    contentType: "text/csv",
  };
}
