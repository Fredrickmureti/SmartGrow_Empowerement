/**
 * LineItemsTable — sales-document line item table.
 *
 * Differs from DataTable (financial reports) in:
 *   - Description column wraps to multiple lines instead of truncating.
 *   - Variable row height based on wrapped description.
 *   - Column visibility driven by a TemplateSettings-style config (so users
 *     can hide line numbers, tax column, etc. via document templates).
 *
 * Page-break safe: triggers builder.newPage() and re-draws the column header
 * on the new page through builder.onNewPage.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import { formatAmount } from "../../format/index.ts";
import {
  resolveLineItemColumns,
  type LineItemColumn,
  type LineItemProfileContext,
} from "../../documents/lineItemProfiles.ts";
import { resolveDisplayUnitPrice } from "../../documents/lineItemPrice.ts";


export interface LineItem {
  description: string;
  sku?: string;
  /** Base-unit quantity (always populated). */
  quantity?: number;
  /** Display-unit quantity entered by the user; null when no packaging is in play. */
  display_quantity?: number | null;
  /** Short pack label, e.g. "Box". */
  packaging_label?: string | null;
  /** Short base unit code, e.g. "ea". Defaults to "ea" when omitted. */
  base_uom_label?: string | null;
  unit_price?: number;
  tax_rate?: number;
  discount_percent?: number;
  line_total: number;
}

/**
 * Render the Qty cell respecting multi-unit pack provenance.
 *   - "1 Box (10 ea)" when packaging present (default).
 *   - "10 ea" when no packaging.
 *   - "1 Box" if showBase=false (compact mode).
 */
function formatQtyCell(item: LineItem, opts: { showBase?: boolean } = {}): string {
  const showBase = opts.showBase !== false;
  const base = Number(item.quantity ?? 0);
  const baseLabel = (item.base_uom_label ?? "ea").trim() || "ea";
  if (item.packaging_label && item.packaging_label.trim().length > 0) {
    const dq = item.display_quantity != null && Number.isFinite(item.display_quantity)
      ? Number(item.display_quantity)
      : base;
    const head = `${trimNum(dq)} ${item.packaging_label.trim()}`;
    return showBase && dq !== base ? `${head} (${trimNum(base)} ${baseLabel})` : head;
  }
  return `${trimNum(base)} ${baseLabel}`;
}
/**
 * Price cell = price of ONE display unit, reconciled against the line total
 * so that Qty × Price = Amount always holds. See resolveDisplayUnitPrice.
 */
function formatPriceCell(item: LineItem): number {
  return resolveDisplayUnitPrice(item);
}
function trimNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(3)));
}

export interface LineItemsTableConfig {
  items: LineItem[];
  currency?: string;
  show_line_numbers?: boolean;
  show_item_sku?: boolean;
  show_quantity?: boolean;
  show_unit_price?: boolean;
  show_tax_column?: boolean;
  show_discount_column?: boolean;
  /** When true (delivery notes), suppress price columns regardless of other flags. */
  hide_amounts?: boolean;
}

type ColumnSpec = LineItemColumn;

/**
 * Column selection is NOT a renderer decision. It is resolved by the shared
 * line-item profile so the A4 grid, the thermal receipt and the POS preview
 * always agree on which columns a document shows.
 */
function toProfileContext(c: LineItemsTableConfig): LineItemProfileContext {
  return {
    showLineNumbers: c.show_line_numbers,
    showSku: c.show_item_sku,
    showQuantity: c.show_quantity,
    showUnitPrice: c.show_unit_price,
    showTax: c.show_tax_column,
    showDiscount: c.show_discount_column,
    hideAmounts: c.hide_amounts,
  };
}

function buildColumns(c: LineItemsTableConfig): ColumnSpec[] {
  return resolveLineItemColumns(toProfileContext(c), "a4");
}


function wrapText(
  text: string,
  font: any,
  fontSize: number,
  maxWidth: number,
): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let cur = "";
    let curW = 0;
    const spaceW = font.widthOfTextAtSize(" ", fontSize);
    for (const word of words) {
      const wW = font.widthOfTextAtSize(word, fontSize);
      if (curW === 0) {
        cur = word;
        curW = wW;
      } else if (curW + spaceW + wW > maxWidth) {
        lines.push(cur);
        cur = word;
        curW = wW;
      } else {
        cur += " " + word;
        curW += spaceW + wW;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length > 0 ? lines : [""];
}

function drawHeaderRow(
  builder: PdfBuilder,
  page: PDFPage,
  cols: ColumnSpec[],
  colWidths: number[],
): void {
  const { state, fontBold } = builder;
  const { margin, contentWidth } = state;
  const headerHeight = theme.tableHeaderHeight;

  // Bold labels + bottom rule. No fill (accountant convention).
  let x = margin;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const tw = fontBold.widthOfTextAtSize(col.header, theme.size.tableHeader);
    const cellX = col.align === "right" ? x + colWidths[i] - tw - 4 : x + 4;
    page.drawText(col.header, {
      x: cellX, y: builder.y - 8,
      size: theme.size.tableHeader, font: fontBold, color: theme.color.text,
    });
    x += colWidths[i];
  }

  page.drawLine({
    start: { x: margin, y: builder.y - headerHeight + 2 },
    end: { x: margin + contentWidth, y: builder.y - headerHeight + 2 },
    thickness: 1, color: theme.color.headerBorder,
  });

  builder.y -= headerHeight + 4;
}

export function drawLineItemsTable(builder: PdfBuilder, config: LineItemsTableConfig): void {
  // Thermal/narrow media are NOT drawn here. They are structured by the
  // canonical Line[] receipt engine and drawn by `renderThermalPdf`
  // (ADR-0085 rendering ownership). The former `drawLineItemsNarrow`
  // stacked-row layout was a second, divergent line-item renderer and has
  // been removed; `generateDocumentPdf` hard-refuses thermal documents.
  if (builder.state.density === "narrow") {
    throw new Error(
      "drawLineItemsTable: narrow/thermal density is not renderable by the A4 " +
        "coordinate table. Route through renderThermalPdf (ADR-0085).",
    );
  }



  const { state, fontRegular } = builder;
  const { margin, contentWidth } = state;
  const cols = buildColumns(config);
  const totalWeight = cols.reduce((s, c) => s + c.weight, 0);
  const colWidths = cols.map((c) => (c.weight / totalWeight) * contentWidth);
  const fontSize = theme.size.tableCell;
  const lineHeight = 11;
  const rowPadding = 6;

  // Guarantee a visible gutter between whatever was drawn above (recipient
  // block, status / amount-due band) and the column-header text. Without
  // this, "Description / Qty / Price / Tax / Amount" can visually touch the
  // status badge or amount due — the exact crowding reported in audits.
  builder.y -= theme.blockGap;
  drawHeaderRow(builder, builder.page, cols, colWidths);

  const descIdx = cols.findIndex((c) => c.key === "description");
  const descWidth = colWidths[descIdx] - 8;

  config.items.forEach((item, index) => {
    const descLines = wrapText(item.description || "", fontRegular, fontSize, descWidth);
    const rowHeight = Math.max(theme.rowHeight, descLines.length * lineHeight + rowPadding);

    // Page break if needed
    if (builder.y - rowHeight < state.bottomMargin) {
      builder.newPage();
      drawHeaderRow(builder, builder.page, cols, colWidths);
    }

    const page = builder.page;
    const rowTop = builder.y;

    let x = margin;
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      let display = "";
      switch (col.key) {
        case "index":
          display = String(index + 1);
          break;
        case "sku":
          display = item.sku || "";
          break;
        case "description":
          // Multi-line — handled below
          break;
        case "qty":
          display = formatQtyCell(item);
          break;
        case "unit_price":
          display = formatAmount(formatPriceCell(item));
          break;
        case "tax":
          display = `${item.tax_rate ?? 0}%`;
          break;
        case "discount":
          display = `${item.discount_percent ?? 0}%`;
          break;

        case "amount":
          display = formatAmount(item.line_total ?? 0);
          break;
      }

      if (col.key === "description") {
        let dy = rowTop - 8;
        for (const line of descLines) {
          page.drawText(line, {
            x: x + 4, y: dy,
            size: fontSize, font: fontRegular, color: theme.color.text,
          });
          dy -= lineHeight;
        }
      } else {
        const tw = fontRegular.widthOfTextAtSize(display, fontSize);
        const cellX = col.align === "right" ? x + colWidths[i] - tw - 4 : x + 4;
        page.drawText(display, {
          x: cellX, y: rowTop - 8,
          size: fontSize, font: fontRegular, color: theme.color.text,
        });
      }
      x += colWidths[i];
    }

    // Light row separator
    page.drawLine({
      start: { x: margin, y: rowTop - rowHeight + 2 },
      end: { x: margin + contentWidth, y: rowTop - rowHeight + 2 },
      thickness: 0.3, color: theme.color.border,
    });

    builder.y -= rowHeight;
  });

  builder.y -= 6;
}
