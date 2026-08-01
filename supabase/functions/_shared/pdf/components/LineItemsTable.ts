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
 * Render the Price cell respecting multi-unit pack provenance.
 * When packaging is present, show price per pack (pack_price = base_unit_price * factor),
 * matching the industry-standard "displayQty × packPrice = total" receipt line.
 */
function formatPriceCell(item: LineItem): number {
  const base = Number(item.quantity ?? 0);
  const unit = Number(item.unit_price ?? 0);
  if (item.packaging_label && item.packaging_label.trim().length > 0) {
    const dq = item.display_quantity != null && Number.isFinite(item.display_quantity)
      ? Number(item.display_quantity)
      : base;
    if (dq > 0 && base > 0 && dq !== base) {
      // Pack price = unit_price × (base_qty / display_qty)
      return unit * (base / dq);
    }
  }
  return unit;
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
  // Stage P2 (ADR-0008): on narrow paper (thermal 58mm / 80mm) the
  // multi-column table is unreadable. Switch to a stacked single-column
  // layout: description on its own wrapped lines, then `qty x price` on
  // the left and the line amount right-aligned. SKU / tax / discount
  // columns are dropped — they are inline metadata on a thermal receipt
  // and the receipt template generator never showed them either.
  if (builder.state.density === "narrow") {
    drawLineItemsNarrow(builder, config);
    return;
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
        case "#":
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
        case "price":
          display = formatAmount(formatPriceCell(item));
          break;
        case "tax":
          display = `${item.tax_rate ?? 0}%`;
          break;
        case "disc":
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

// ── Narrow (thermal) layout ────────────────────────────────────────────────
function drawLineItemsNarrow(builder: PdfBuilder, config: LineItemsTableConfig): void {
  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;
  const fontSize = 8;
  const lineHeight = 10;
  const rowGap = 4;

  builder.y -= 6;

  // Top rule + header
  builder.page.drawLine({
    start: { x: margin, y: builder.y + 2 },
    end: { x: margin + contentWidth, y: builder.y + 2 },
    thickness: 0.5, color: theme.color.headerBorder,
  });
  builder.y -= 2;
  builder.page.drawText("Item", {
    x: margin, y: builder.y - 8,
    size: fontSize, font: fontBold, color: theme.color.text,
  });
  const amtHeader = "Amount";
  const amtHw = fontBold.widthOfTextAtSize(amtHeader, fontSize);
  builder.page.drawText(amtHeader, {
    x: margin + contentWidth - amtHw, y: builder.y - 8,
    size: fontSize, font: fontBold, color: theme.color.text,
  });
  builder.y -= lineHeight + 2;
  builder.page.drawLine({
    start: { x: margin, y: builder.y + 2 },
    end: { x: margin + contentWidth, y: builder.y + 2 },
    thickness: 0.3, color: theme.color.border,
  });

  const hideAmounts = !!config.hide_amounts;

  config.items.forEach((item) => {
    const descLines = wrapText(item.description || "", fontRegular, fontSize, contentWidth);
    const qtyLabel = formatQtyCell(item, { showBase: false });
    const price = formatPriceCell(item);
    const breakdown = hideAmounts
      ? `Qty: ${qtyLabel}`
      : `${qtyLabel} x ${formatAmount(price)}`;
    const amount = formatAmount(item.line_total ?? 0);

    const rowHeight = descLines.length * lineHeight + lineHeight + rowGap;

    if (builder.y - rowHeight < state.bottomMargin) {
      builder.newPage();
    }

    let dy = builder.y - 8;
    for (const line of descLines) {
      builder.page.drawText(line, {
        x: margin, y: dy,
        size: fontSize, font: fontRegular, color: theme.color.text,
      });
      dy -= lineHeight;
    }

    // qty x price (left) + amount (right) on its own line
    builder.page.drawText(breakdown, {
      x: margin, y: dy,
      size: fontSize, font: fontRegular, color: theme.color.medGray,
    });
    if (!hideAmounts) {
      const aw = fontRegular.widthOfTextAtSize(amount, fontSize);
      builder.page.drawText(amount, {
        x: margin + contentWidth - aw, y: dy,
        size: fontSize, font: fontRegular, color: theme.color.text,
      });
    }
    builder.y -= rowHeight;
  });

  builder.page.drawLine({
    start: { x: margin, y: builder.y + 2 },
    end: { x: margin + contentWidth, y: builder.y + 2 },
    thickness: 0.3, color: theme.color.border,
  });
  builder.y -= 4;
}
