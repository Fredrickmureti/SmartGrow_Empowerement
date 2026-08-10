/**
 * SummaryBlock — horizontal KPI strip at the bottom of a report.
 * Used for aging buckets, period totals, etc.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import { DOCUMENT_TYPOGRAPHY, type Typography } from "../themes/presentation.ts";

export interface SummaryItem {
  label: string;
  value: string;
}

/**
 * Draws a separator + a single horizontal row of label/value pairs at
 * builder.y. Triggers a page break if needed. Updates builder.y.
 *
 * `typography` is optional; omitted resolves to the document profile so
 * every existing caller renders byte-identically.
 */
export function drawSummaryBlock(
  builder: PdfBuilder,
  page: PDFPage,
  items: SummaryItem[],
  typography?: Typography,
): void {
  if (!items || items.length === 0) return;
  const t = typography ?? DOCUMENT_TYPOGRAPHY;

  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth, contentWidth } = state;

  builder.y -= 6;

  if (builder.y - 24 < state.bottomMargin) {
    builder.newPage();
    page = builder.page;
  }

  // Top separator
  page.drawLine({
    start: { x: margin, y: builder.y },
    end: { x: pageWidth - margin, y: builder.y },
    thickness: 1.5, color: theme.color.text,
  });
  builder.y -= 16;

  const itemWidth = contentWidth / items.length;
  // Reserve a small gutter so adjacent values don't touch.
  const slotWidth = itemWidth - 8;
  const MIN_VALUE_FONT = 6;

  let sx = margin;
  for (const item of items) {
    page.drawText(item.label, {
      x: sx, y: builder.y,
      size: theme.size.summaryLabel, font: fontRegular, color: theme.color.medGray,
    });

    // Accountant safety: never truncate a monetary value. If it doesn't
    // fit the slot at the default font size, shrink the font down to
    // MIN_VALUE_FONT so every digit remains visible.
    let valueSize = theme.size.summaryValue;
    while (
      fontBold.widthOfTextAtSize(item.value, valueSize) > slotWidth &&
      valueSize > MIN_VALUE_FONT
    ) {
      valueSize -= 0.25;
    }

    page.drawText(item.value, {
      x: sx, y: builder.y - 11,
      size: valueSize, font: fontBold, color: theme.color.text,
    });
    sx += itemWidth;
  }
  builder.y -= 24;
}
