/**
 * DataTable — renders a tabular report (Trial Balance, P&L, GL, etc.)
 * with hierarchical indentation, subtotal/grand-total emphasis, automatic
 * page breaks, and currency-aware formatting.
 *
 * Inputs are designed to mirror the existing ReportPdfPayload shape so
 * the financial-report generator can call this directly without changing
 * its public API.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import {
  DOCUMENT_TYPOGRAPHY,
  type Typography,
} from "../themes/presentation.ts";
import { formatAccountingNumber } from "../../format/index.ts";
import {
  resolveLineKind,
  STATEMENT_LINE_TREATMENT,
  type StatementLineKind,
} from "../../reports/statementKinds.ts";
import { winansiSafe } from "../winansi.ts";


export interface TableColumn {
  key: string;
  header: string;
  width?: number;
  format?: string;
  align?: "left" | "center" | "right";
}

/**
 * Optional drill-down metadata embedded on a row. The PDF rendering layer
 * ignores this; consumers reading the JSON form of a report (UI drill-down,
 * audit packs) can use it to navigate from a report line back to the
 * underlying account / journal entry / source document.
 */
export interface RowMeta {
  accountId?: string;
  accountIds?: string[];
  journalId?: string;
  sourceDocType?: string;
  sourceDocId?: string;
}

export interface TableRow {
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
  /**
   * Canonical semantic kind of the line (see `reports/statementKinds.ts`).
   * When present it wins over the legacy booleans below, which are retained
   * so pre-contract reports render exactly as before.
   */
  _kind?: StatementLineKind;
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
  _depth?: number;
  /** Stage E: drill-down metadata. Not rendered. */
  _meta?: RowMeta;
}

export interface DataTableConfig {
  columns: TableColumn[];
  rows: TableRow[];
  currency?: string;
  /**
   * Resolved presentation tokens (see `themes/presentation.ts`). Omitted =
   * the document profile, i.e. exactly the pre-profile behaviour. Report
   * callers pass the profile resolved by the report registry.
   */
  typography?: Typography;
  /**
   * Statement mode. Enables the statutory presentation policy: semantic
   * spacing around totals, upper-cased result captions, spacer lines, and
   * zero rendered as an accounting dash. OFF for every other document so
   * invoices / ledgers / registers stay byte-identical.
   */
  statement?: boolean;
}


/**
 * Numeric formats whose values must NEVER be truncated. Truncating
 * "KES 10,000,000.00" to "KES 10,00…" would silently misrepresent the
 * figure by three orders of magnitude — unacceptable in any accounting
 * report. For these columns we reserve enough width up-front and, as a
 * last-resort safety net, shrink the font instead of clipping digits.
 */
const NUMERIC_FORMATS = new Set(["currency", "number", "percent"]);

/**
 * Absolute legibility floor for a numeric cell. Presentation profiles raise
 * this (ledgers to 7.5pt, statements to 8.5pt) via `Typography`; this
 * constant is the document-profile value and the hard backstop.
 */
const MIN_NUMERIC_FONT_SIZE = 6;
void MIN_NUMERIC_FONT_SIZE;

/**
 * Word-wrap a single text string to fit within `maxWidth`. Splits on
 * whitespace first; if a single token still exceeds the column width
 * (long codes, identifiers, hashes, comma-separated parameter blobs),
 * it is hard-broken character-by-character. Never truncates — every
 * character makes it into the output. This is what guarantees that
 * statutory-rule parameter columns are never silently clipped.
 */
function wrapText(
  text: string,
  font: import("https://esm.sh/pdf-lib@1.17.1").PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  if (!text) return [""];
  text = winansiSafe(text);
  if (maxWidth <= 0) return [text];
  const measure = (s: string) => font.widthOfTextAtSize(s, fontSize);

  const hardBreak = (token: string): string[] => {
    const out: string[] = [];
    let cur = "";
    for (const ch of token) {
      const next = cur + ch;
      if (measure(next) <= maxWidth || cur === "") {
        cur = next;
      } else {
        out.push(cur);
        cur = ch;
      }
    }
    if (cur) out.push(cur);
    return out;
  };

  const lines: string[] = [];
  // Preserve explicit newlines in source data.
  for (const paragraph of text.split(/\r?\n/)) {
    const tokens = paragraph.split(/(\s+)/).filter((t) => t.length > 0);
    let line = "";
    for (const tok of tokens) {
      const candidate = line + tok;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
      } else {
        if (line.trim()) lines.push(line.trimEnd());
        if (measure(tok) > maxWidth) {
          const pieces = hardBreak(tok);
          for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]);
          line = pieces[pieces.length - 1] ?? "";
        } else {
          line = tok.trimStart();
        }
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
    if (!tokens.length) lines.push("");
  }
  return lines.length ? lines : [""];
}

function isNumericColumn(col: TableColumn): boolean {
  return !!col.format && NUMERIC_FORMATS.has(col.format);
}

/** Format a row's cell value the same way the renderer will. */
function formatCellValue(
  col: TableColumn,
  rawVal: unknown,
  isHeader: boolean,
  currency?: string,
  zeroAsDash?: boolean,
  isTotalRow?: boolean,
): string {
  if (rawVal === null || rawVal === undefined || rawVal === "") {
    // A total row has no line number, no account code and no narration —
    // printing "—" in those cells asserts a missing value that was never
    // supposed to exist. Money columns keep the dash: there, "nothing on
    // this side" is a real accounting statement.
    return winansiSafe(isHeader || (isTotalRow && !isNumericColumn(col)) ? "" : "—");
  }
  // Statutory statements print a nil figure as a dash, never as 0.00 —
  // "0.00" asserts a measured zero, "—" asserts nothing to report.
  if (zeroAsDash && typeof rawVal === "number" && rawVal === 0 && isNumericColumn(col)) {
    return winansiSafe("—");
  }

  if (col.format === "currency" && typeof rawVal === "number") {
    return winansiSafe(formatAccountingNumber(rawVal, currency));
  }
  if (col.format === "percent" && typeof rawVal === "number") {
    return winansiSafe(`${rawVal.toFixed(1)}%`);
  }
  if (col.format === "number" && typeof rawVal === "number") {
    return winansiSafe(rawVal.toLocaleString("en-US"));
  }
  return winansiSafe(String(rawVal));
}


/**
 * Computes column widths that are safe for accounting reports.
 *
 * Algorithm:
 *  1. For numeric columns (currency / number / percent), measure the widest
 *     rendered value across the header and ALL data rows, then reserve that
 *     many points + cell padding. These columns get exactly what they need —
 *     never less. This eliminates monetary-value truncation entirely.
 *  2. The remaining width is distributed proportionally across text columns
 *     using their declared `width` weights. Text columns (descriptions,
 *     names) are still allowed to ellipsize — that's safe.
 *  3. If the numeric reservations exceed total content width (extreme edge
 *     case — many wide currency columns on a narrow page), shrink them
 *     proportionally so they still sum to contentWidth. The font-shrink
 *     safety net in the render loop then preserves digit visibility.
 */
function computeColWidths(
  columns: TableColumn[],
  rows: TableRow[],
  contentWidth: number,
  fontRegular: import("https://esm.sh/pdf-lib@1.17.1").PDFFont,
  fontBold: import("https://esm.sh/pdf-lib@1.17.1").PDFFont,
  currency: string | undefined,
  t: Typography,
): number[] {
  const CELL_PAD = 8; // 4pt left + 4pt right inside each cell
  const widths = new Array<number>(columns.length).fill(0);

  // Step 1: numeric columns get measured-exact width.
  let numericReserved = 0;
  let textWeightTotal = 0;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (isNumericColumn(col)) {
      // Header width (bold)
      let maxW = fontBold.widthOfTextAtSize(winansiSafe(col.header), t.size.tableHeader);
      // Each row's formatted value (use the larger of regular / bold sizes
      // since subtotal / grand-total rows render in bold + emphasis size).
      for (const row of rows) {
        const text = formatCellValue(col, row[col.key], !!row._isHeader, currency);
        if (!text) continue;
        const isEmph = row._isSubtotal || row._isGrandTotal || row._isHeader;
        const font = isEmph ? fontBold : fontRegular;
        const size = isEmph ? t.size.tableCellEmphasis : t.size.tableCell;
        const w = font.widthOfTextAtSize(text, size);
        if (w > maxW) maxW = w;
      }
      widths[i] = maxW + CELL_PAD;
      numericReserved += widths[i];
    } else {
      textWeightTotal += col.width || 15;
    }
  }

  // Step 2: compute a content-aware MINIMUM for each text column so the
  // payroll-register style layouts (many numeric columns, few text columns)
  // never collapse the name/code columns down to a few points — which used
  // to cause `wrapText` to hard-break names character-by-character
  // ("F r e d r i c k  M u r e t i") and the column-header row to overlap
  // its neighbours ("Employee Emp # Basic Salary" stacked).
  //
  // The minimum is the larger of:
  //   • the header label width (so headers never collide), and
  //   • a "longest single token" probe over the row data (so names like
  //     "Fredrick" stay on one line — we wrap on spaces, not chars).
  // Capped at 40% of contentWidth per column so a freakishly long token
  // can't single-handedly starve the numeric side.
  const textMins = new Array<number>(columns.length).fill(0);
  let textMinTotal = 0;
  const TEXT_CAP = contentWidth * 0.4;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (isNumericColumn(col)) continue;
    let minW = fontBold.widthOfTextAtSize(winansiSafe(col.header), t.size.tableHeader);
    for (const row of rows) {
      const text = formatCellValue(col, row[col.key], !!row._isHeader, currency);
      if (!text) continue;
      const isEmph = row._isSubtotal || row._isGrandTotal || row._isHeader;
      const font = isEmph ? fontBold : fontRegular;
      const size = isEmph ? t.size.tableCellEmphasis : t.size.tableCell;
      // Widest single whitespace-delimited token — that's the smallest the
      // column can shrink to without forcing per-character hard-breaks.
      for (const token of String(text).split(/\s+/)) {
        if (!token) continue;
        const w = font.widthOfTextAtSize(token, size);
        if (w > minW) minW = w;
      }
    }
    textMins[i] = Math.min(minW + CELL_PAD, TEXT_CAP);
    textMinTotal += textMins[i];
  }

  const remainder = contentWidth - numericReserved;

  if (remainder >= textMinTotal) {
    // Plenty of room: give text columns their weighted share of the
    // remainder, but never less than the computed minimum.
    let leftover = remainder;
    // First pass: clamp to the minimum where the weighted share is too small.
    const weighted = new Array<number>(columns.length).fill(0);
    let weightSumFloating = textWeightTotal;
    let remainderFloating = remainder;
    const locked = new Array<boolean>(columns.length).fill(false);
    // Iterate until no new minimums get locked.
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (isNumericColumn(col) || locked[i]) continue;
        const share = ((col.width || 15) / weightSumFloating) * remainderFloating;
        if (share < textMins[i]) {
          widths[i] = textMins[i];
          locked[i] = true;
          weightSumFloating -= col.width || 15;
          remainderFloating -= textMins[i];
          changed = true;
        } else {
          weighted[i] = share;
        }
      }
    }
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (isNumericColumn(col) || locked[i]) continue;
      widths[i] = ((col.width || 15) / weightSumFloating) * remainderFloating;
    }
    void leftover;
  } else {
    // Step 3: text minimums + numeric reservations overflow the page.
    // Honour the text minimums where they fit, but they are only capped
    // PER COLUMN (40% of contentWidth); with five or more text columns
    // their sum can exceed the whole page. The previous code wrote those
    // unscaled minimums out and then floored the numeric budget at 30%
    // of contentWidth, so the row could total >100% and the right-hand
    // columns were drawn past the right margin — off the paper. Scale
    // the text side down so text + numeric always sums to contentWidth.
    const numericFloor = Math.min(numericReserved, contentWidth * 0.3);
    const textBudget = Math.max(contentWidth - numericFloor, 0);
    const textScale = textMinTotal > textBudget && textMinTotal > 0
      ? textBudget / textMinTotal
      : 1;
    let textUsed = 0;
    for (let i = 0; i < columns.length; i++) {
      if (isNumericColumn(columns[i])) continue;
      widths[i] = textMins[i] * textScale;
      textUsed += widths[i];
    }
    const numericBudget = Math.max(contentWidth - textUsed, 0);
    const scale = numericReserved > 0 ? numericBudget / numericReserved : 1;
    for (let i = 0; i < columns.length; i++) {
      if (isNumericColumn(columns[i])) widths[i] *= scale;
    }
  }

  return widths;
}

/** Draws the column-header row: bold labels + bottom rule. No fill. */
function drawTableHeader(
  builder: PdfBuilder,
  page: PDFPage,
  columns: TableColumn[],
  colWidths: number[],
  y: number,
  t: Typography,
): number {
  const { state, fontBold } = builder;
  const { margin, contentWidth } = state;

  // ── Optional group tier ────────────────────────────────────────────
  // A column may declare a `group` ("Opening balance"). Contiguous columns
  // sharing a group are banded under one centred caption with a hairline
  // beneath it, so a trial balance reads
  //   Opening balance | Movement | Closing balance
  //        Dr   Cr    |  Dr  Cr  |     Dr   Cr
  // instead of six anonymous Debit/Credit columns.
  interface GroupRun { label: string; x: number; width: number }
  const runs: GroupRun[] = [];
  if (columns.some((c) => c.group)) {
    let x = margin;
    for (let i = 0; i < columns.length; i++) {
      const label = columns[i].group ?? "";
      const last = runs[runs.length - 1];
      if (last && last.label === label && label !== "") {
        last.width += colWidths[i];
      } else {
        runs.push({ label, x, width: colWidths[i] });
      }
      x += colWidths[i];
    }
  }
  const groupSize = Math.max(t.size.tableHeader - 0.5, 5);
  const groupStep = runs.length > 0 ? groupSize + 8 : 0;

  if (runs.length > 0) {
    for (const run of runs) {
      if (!run.label) continue;
      const tw = fontBold.widthOfTextAtSize(run.label, groupSize);
      page.drawText(run.label, {
        x: run.x + Math.max((run.width - tw) / 2, 2),
        y: y - 10,
        size: groupSize,
        font: fontBold,
        color: theme.color.text,
      });
      page.drawLine({
        start: { x: run.x + 2, y: y - 14 },
        end: { x: run.x + run.width - 2, y: y - 14 },
        thickness: 0.5,
        color: theme.color.border,
      });
    }
  }

  const headerY = y - groupStep;

  // First pass: wrap each header and find the max line count so the
  // separator rule can sit BELOW all wrapped lines instead of slashing
  // through them (e.g. long compound labels like "Basic Sal / ary").
  const headerLines: string[][] = [];
  let maxLines = 1;
  for (let i = 0; i < columns.length; i++) {
    const maxW = Math.max(colWidths[i] - 8, 1);
    const lines = wrapText(columns[i].header, fontBold, t.size.tableHeader, maxW);
    headerLines.push(lines);
    if (lines.length > maxLines) maxLines = lines.length;
  }
  const lineStep = t.size.tableHeader + 1.5;

  let x = margin;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const lines = headerLines[i];
    // Bottom-align wrapped headers so the last line of every column sits on
    // the same baseline, just above the separator rule.
    const offset = maxLines - lines.length;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const tw = fontBold.widthOfTextAtSize(line, t.size.tableHeader);
      const cellX = col.align === "right"
        ? x + colWidths[i] - tw - 4
        : col.align === "center"
        ? x + (colWidths[i] - tw) / 2
        : x + 4;
      page.drawText(line, {
        x: cellX,
        y: headerY - 10 - (offset + li) * lineStep,
        size: t.size.tableHeader,
        font: fontBold,
        color: theme.color.text,
      });
    }
    x += colWidths[i];
  }

  // Separator sits below the tallest wrapped header column.
  const extraLines = maxLines - 1;
  const ruleY = headerY - 16 - extraLines * lineStep;
  page.drawLine({
    start: { x: margin, y: ruleY },
    end: { x: margin + contentWidth, y: ruleY },
    thickness: 1, color: theme.color.headerBorder,
  });

  return ruleY - 6;
}


/**
 * Renders the entire table starting at builder.y. Handles page breaks
 * internally by calling builder.newPage() (which re-runs the BrandedHeader
 * via builder.onNewPage) and re-drawing the column headers on each page.
 *
 * Mutates builder.page and builder.y as it goes.
 */
export function drawDataTable(builder: PdfBuilder, config: DataTableConfig): void {
  // V2 (ADR-0008): on thermal paper, render a stacked label/value list per
  // row instead of a wide grid. Multi-column statements at 80mm/58mm would
  // otherwise compress every column to a few characters.
  if (builder.state.density === "narrow") {
    drawNarrowTable(builder, config);
    return;
  }
  const { columns, rows, currency } = config;
  const t = config.typography ?? DOCUMENT_TYPOGRAPHY;
  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;

  const colWidths = computeColWidths(
    columns, rows, contentWidth, fontRegular, fontBold, currency, t,
  );

  // Initial header
  builder.y = drawTableHeader(builder, builder.page, columns, colWidths, builder.y, t);

  const LINE_GAP = 1.5; // extra leading between wrapped lines within a cell
  const ROW_VPAD = 6;   // top+bottom padding inside each row

  const statement = !!config.statement;

  const drawRule = (
    page: PDFPage,
    kindOfRule: "thin" | "single" | "double",
    yPos: number,
  ) => {
    if (kindOfRule === "double") {
      page.drawLine({
        start: { x: margin, y: yPos + 4 },
        end: { x: margin + contentWidth, y: yPos + 4 },
        thickness: 1, color: theme.color.text,
      });
      page.drawLine({
        start: { x: margin, y: yPos + 2 },
        end: { x: margin + contentWidth, y: yPos + 2 },
        thickness: 1, color: theme.color.text,
      });
      return;
    }
    page.drawLine({
      start: { x: margin, y: yPos + 2 },
      end: { x: margin + contentWidth, y: yPos + 2 },
      thickness: kindOfRule === "single" ? 0.75 : 0.5,
      color: kindOfRule === "single" ? theme.color.text : theme.color.border,
    });
  };

  for (const row of rows) {
    const kind = resolveLineKind(row);
    const treat = STATEMENT_LINE_TREATMENT[kind];
    const depth = (row._depth as number) || 0;

    // A spacer is vertical rhythm, not data. Under the statement profile it
    // survives into the PDF so sections breathe exactly as they do on
    // screen; elsewhere it is ignored (pre-contract behaviour).
    if (kind === "spacer") {
      if (statement) {
        if (builder.y - t.rowHeight * 0.6 < state.bottomMargin) {
          builder.newPage();
          builder.y = drawTableHeader(builder, builder.page, columns, colWidths, builder.y, t);
        } else {
          builder.y -= t.rowHeight * 0.6;
        }
      }
      continue;
    }

    const isCaption = treat.caption;
    const font = treat.bold ? fontBold : fontRegular;
    const baseFontSize = treat.emphasis ? t.size.tableCellEmphasis : t.size.tableCell;
    const spaceAbove = statement ? treat.spaceAbove : 0;
    const spaceBelow = statement ? treat.spaceBelow : 0;

    // ── Pre-pass: format every cell, decide font size, and word-wrap text
    //    cells. This gives us the row's true height before we draw anything,
    //    so multi-line cells can never overrun the page footer.
    interface CellPlan {
      lines: string[];
      fontSize: number;
      align: "left" | "center" | "right";
      indent: number;
      cellWidth: number;
    }
    const cellPlans: CellPlan[] = [];
    let maxLines = 1;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      let display = formatCellValue(
        col, row[col.key], isCaption, currency, statement,
        !!(row._isSubtotal || row._isGrandTotal),
      );
      if (statement && treat.uppercase && i === 0) display = display.toUpperCase();
      const indent = i === 0 && depth > 0 ? depth * 12 : 0;
      const maxCellWidth = colWidths[i] - 8 - indent;

      let lines: string[];
      let fontSize = baseFontSize;

      if (isNumericColumn(col)) {
        // Numeric: never wrap, never truncate — shrink font instead.
        let text = winansiSafe(display);
        while (
          font.widthOfTextAtSize(text, fontSize) > maxCellWidth &&
          fontSize > t.minNumericFontSize
        ) {
          fontSize -= 0.25;
        }
        lines = [text];
      } else {
        // Text: wrap onto as many lines as needed. No truncation.
        lines = wrapText(display, font, fontSize, Math.max(maxCellWidth, 1));
      }

      if (lines.length > maxLines) maxLines = lines.length;
      cellPlans.push({
        lines,
        fontSize,
        align: col.align ?? "left",
        indent,
        cellWidth: colWidths[i],
      });
    }

    const lineH = baseFontSize + LINE_GAP;
    const rowHeight = Math.max(t.rowHeight, maxLines * lineH + ROW_VPAD);

    // Page-break check uses the *actual* row height plus its semantic
    // spacing, so a total never lands orphaned against the footer.
    if (builder.y - spaceAbove - rowHeight - spaceBelow < state.bottomMargin) {
      builder.newPage();
      builder.y = drawTableHeader(builder, builder.page, columns, colWidths, builder.y, t);
    } else {
      builder.y -= spaceAbove;
    }

    const page = builder.page;
    const y = builder.y;

    if (treat.ruleAbove !== "none") drawRule(page, treat.ruleAbove, y);


    // Render cells
    let x = margin;
    for (const plan of cellPlans) {
      for (let li = 0; li < plan.lines.length; li++) {
        const lineText = winansiSafe(plan.lines[li]);
        const tw = font.widthOfTextAtSize(lineText, plan.fontSize);
        const cellX = plan.align === "right"
          ? x + plan.cellWidth - tw - 4
          : plan.align === "center"
          ? x + (plan.cellWidth - tw) / 2
          : x + 4 + plan.indent;
        page.drawText(lineText, {
          x: cellX,
          y: y - 8 - li * lineH,
          size: plan.fontSize,
          font,
          color: theme.color.text,
        });
      }
      x += plan.cellWidth;
    }

    builder.y -= rowHeight;

    if (treat.ruleBelow !== "none") drawRule(page, treat.ruleBelow, builder.y + 4);
    builder.y -= spaceBelow;
  }

}

/** Narrow (thermal) table: stacked label: value rows per record. */
function drawNarrowTable(builder: PdfBuilder, config: DataTableConfig): void {
  const { columns, rows, currency } = config;
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth } = state;
  const leftX = margin;
  const rightX = pageWidth - margin;
  const lineH = 9;

  for (const row of rows) {
    const kind = resolveLineKind(row);
    if (kind === "spacer") continue;
    const treat = STATEMENT_LINE_TREATMENT[kind];
    const isEmph = treat.bold;
    const font = isEmph ? fontBold : fontRegular;
    const size = isEmph ? 8 : 7;

    // Find primary text column for the row title (first non-numeric).
    const titleCol = columns.find((c) => !isNumericColumn(c)) ?? columns[0];
    const title = formatCellValue(titleCol, row[titleCol.key], treat.caption, currency) || "";

    builder.ensureSpace(lineH);
    if (title) {
      page_drawWrapped(builder, title, leftX, size, font, isEmph ? theme.color.text : theme.color.text, rightX - leftX);
    }

    // Then each numeric column on its own indented line.
    for (const col of columns) {
      if (col === titleCol) continue;
      const val = formatCellValue(col, row[col.key], treat.caption, currency);
      if (!val || val === "—") continue;
      builder.ensureSpace(lineH);
      const labelText = winansiSafe(`  ${col.header}:`);
      builder.page.drawText(labelText, {
        x: leftX, y: builder.y, size, font: fontRegular, color: theme.color.medGray,
      });
      const vw = font.widthOfTextAtSize(val, size);
      builder.page.drawText(val, {
        x: rightX - vw, y: builder.y, size, font, color: theme.color.text,
      });
      builder.y -= lineH;
    }

    // Subtotal/grand-total separator
    if (treat.ruleAbove !== "none") {
      const heavy = treat.ruleAbove === "double" || treat.ruleAbove === "single";
      builder.ensureSpace(3);
      builder.page.drawLine({
        start: { x: leftX, y: builder.y + 2 },
        end: { x: rightX, y: builder.y + 2 },
        thickness: heavy ? 0.75 : 0.4,
        color: heavy ? theme.color.text : theme.color.border,
      });
      builder.y -= 3;
    }
  }
}

function page_drawWrapped(
  builder: PdfBuilder,
  text: string,
  x: number,
  size: number,
  font: import("https://esm.sh/pdf-lib@1.17.1").PDFFont,
  color: { type: string; [k: string]: unknown } | ReturnType<typeof noop>,
  maxWidth: number,
): void {
  const lineH = size + 2;
  const lines = wrapText(text, font, size, maxWidth);
  for (const ln of lines) {
    builder.ensureSpace(lineH);
    builder.page.drawText(ln, { x, y: builder.y, size, font, color: color as never });
    builder.y -= lineH;
  }
}
function noop() { return theme.color.text; }
