/**
 * TotalsBlock — right-aligned subtotal/discount/tax/total stack with the
 * accounting-standard double underline above the grand total.
 *
 * Used by ALL sales documents (invoices, estimates, proformas, credit notes,
 * POs, receipts, sales orders, sales returns, bills) so totals always render
 * the exact same way.
 *
 * Mutates builder.y as it draws. Triggers page break if needed.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import { formatAccountingNumber } from "../../format/index.ts";

export interface TotalsLine {
  label: string;
  value: number;
  /** Render value as negative (parenthesized). Use for discounts / amount-paid. */
  negate?: boolean;
}

export interface TotalsBlockConfig {
  currency?: string;
  subtotal?: number;
  discount?: number;
  tax?: number;
  /** Extra lines (e.g., shipping, custom adjustments) drawn between tax and total. */
  extraLines?: TotalsLine[];
  /** Grand total (always shown). */
  total: number;
  /** Optional amount paid (drawn under the grand total). */
  amountPaid?: number;
  /** Optional balance due (drawn under amount paid; emphasized). */
  balanceDue?: number;
  /** Approximate width in pts for the totals stack. Default: 200. */
  blockWidth?: number;
}

export function drawTotalsBlock(
  builder: PdfBuilder,
  page: PDFPage,
  config: TotalsBlockConfig,
): void {
  // V2 (ADR-0008): on thermal/narrow paper, render a full-width stacked
  // totals list — the wide layout right-aligns a 200pt+ block which
  // overruns 80mm/58mm paper.
  if (builder.state.density === "narrow") {
    drawNarrowTotals(builder, page, config);
    return;
  }
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth } = state;
  const currency = config.currency;

  const lineHeight = 14;
  const lines: TotalsLine[] = [];

  if (config.subtotal !== undefined) {
    lines.push({ label: "Subtotal", value: config.subtotal });
  }
  if (config.discount !== undefined && config.discount > 0) {
    lines.push({ label: "Discount", value: config.discount, negate: true });
  }
  if (config.tax !== undefined && config.tax > 0) {
    lines.push({ label: "Tax", value: config.tax });
  }
  if (config.extraLines) {
    for (const l of config.extraLines) lines.push(l);
  }

  // ── Auto-size the totals stack to fit the widest formatted value ──────
  // Hardcoding a 200pt block was the source of "Total: KES 10,00…" style
  // truncation when values exceeded that width. We measure every value
  // (and every label) up front and grow the block to fit, capped at the
  // page's content area so we never run off the edge.
  const LABEL_GAP = 24; // padding between label column and value column
  const allValues: { text: string; emph: boolean }[] = [];
  for (const l of lines) {
    allValues.push({ text: formatAccountingNumber(l.negate ? -l.value : l.value, currency), emph: false });
  }
  allValues.push({ text: formatAccountingNumber(config.total, currency), emph: true });
  if (config.amountPaid !== undefined) {
    allValues.push({ text: formatAccountingNumber(-Math.abs(config.amountPaid), currency), emph: false });
  }
  if (config.balanceDue !== undefined && Math.abs(config.balanceDue) > 0.005) {
    allValues.push({ text: formatAccountingNumber(config.balanceDue, currency), emph: true });
  }

  const allLabels = [
    ...lines.map((l) => l.label),
    "Total",
    config.amountPaid !== undefined ? "Amount Paid" : null,
    (config.balanceDue !== undefined && Math.abs(config.balanceDue) > 0.005) ? "Balance Due" : null,
  ].filter(Boolean) as string[];

  const widestValueW = allValues.reduce((m, v) => {
    const w = (v.emph ? fontBold : fontRegular).widthOfTextAtSize(
      v.text,
      v.emph ? theme.size.amountDueValue : theme.size.summaryValue,
    );
    return Math.max(m, w);
  }, 0);
  const widestLabelW = allLabels.reduce((m, l) => {
    const w = fontBold.widthOfTextAtSize(l, theme.size.amountDueLabel);
    return Math.max(m, w);
  }, 0);

  const measuredBlockWidth = widestLabelW + LABEL_GAP + widestValueW + 4;
  const maxBlockWidth = pageWidth - margin * 2; // never wider than content area
  const blockWidth = Math.min(maxBlockWidth, Math.max(config.blockWidth ?? 200, measuredBlockWidth));
  const labelX = pageWidth - margin - blockWidth;
  const valueRightX = pageWidth - margin;

  // Reserve enough vertical space (lines + grand total + optional paid/balance)
  const extraRows = (config.amountPaid !== undefined ? 1 : 0)
    + (config.balanceDue !== undefined ? 1 : 0);
  const totalHeight = lines.length * lineHeight + 6 + 18 + extraRows * lineHeight + 8;
  builder.ensureSpace(totalHeight);

  // Subtotal / discount / tax lines
  for (const line of lines) {
    const display = formatAccountingNumber(line.negate ? -line.value : line.value, currency);
    const tw = fontRegular.widthOfTextAtSize(display, theme.size.summaryValue);
    page.drawText(line.label, {
      x: labelX, y: builder.y,
      size: theme.size.summaryValue, font: fontRegular, color: theme.color.medGray,
    });
    page.drawText(display, {
      x: valueRightX - tw, y: builder.y,
      size: theme.size.summaryValue, font: fontRegular, color: theme.color.text,
    });
    builder.y -= lineHeight;
  }

  // Double underline + grand total (accounting convention)
  builder.y -= 2;
  page.drawLine({
    start: { x: labelX - 6, y: builder.y + 12 },
    end: { x: valueRightX, y: builder.y + 12 },
    thickness: 1, color: theme.color.text,
  });
  page.drawLine({
    start: { x: labelX - 6, y: builder.y + 10 },
    end: { x: valueRightX, y: builder.y + 10 },
    thickness: 1, color: theme.color.text,
  });

  const totalText = formatAccountingNumber(config.total, currency);
  const totalW = fontBold.widthOfTextAtSize(totalText, theme.size.amountDueValue);
  page.drawText("Total", {
    x: labelX, y: builder.y - 2,
    size: theme.size.amountDueLabel, font: fontBold, color: theme.color.text,
  });
  page.drawText(totalText, {
    x: valueRightX - totalW, y: builder.y - 2,
    size: theme.size.amountDueValue, font: fontBold, color: theme.color.text,
  });
  builder.y -= 18;

  // Amount paid (if provided)
  if (config.amountPaid !== undefined) {
    const paidText = formatAccountingNumber(-Math.abs(config.amountPaid), currency);
    const paidW = fontRegular.widthOfTextAtSize(paidText, theme.size.summaryValue);
    page.drawText("Amount Paid", {
      x: labelX, y: builder.y,
      size: theme.size.summaryValue, font: fontRegular, color: theme.color.medGray,
    });
    page.drawText(paidText, {
      x: valueRightX - paidW, y: builder.y,
      size: theme.size.summaryValue, font: fontRegular, color: theme.color.text,
    });
    builder.y -= lineHeight;
  }

  // Balance due (if provided and non-zero)
  if (config.balanceDue !== undefined && Math.abs(config.balanceDue) > 0.005) {
    const balanceText = formatAccountingNumber(config.balanceDue, currency);
    const balanceW = fontBold.widthOfTextAtSize(balanceText, theme.size.amountDueLabel);
    page.drawText("Balance Due", {
      x: labelX, y: builder.y,
      size: theme.size.amountDueLabel, font: fontBold, color: theme.color.text,
    });
    page.drawText(balanceText, {
      x: valueRightX - balanceW, y: builder.y,
      size: theme.size.amountDueLabel, font: fontBold, color: theme.color.text,
    });
    builder.y -= lineHeight;
  }

  builder.y -= 4;
}

/** Narrow (thermal) totals: full-width label-left value-right rows. */
function drawNarrowTotals(
  builder: PdfBuilder,
  page: PDFPage,
  config: TotalsBlockConfig,
): void {
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth } = state;
  const currency = config.currency;
  const leftX = margin;
  const rightX = pageWidth - margin;
  const lineH = 11;

  const drawRow = (label: string, value: string, bold: boolean) => {
    builder.ensureSpace(lineH);
    const font = bold ? fontBold : fontRegular;
    const size = bold ? 9 : 8;
    page.drawText(label, {
      x: leftX, y: builder.y, size, font,
      color: bold ? theme.color.text : theme.color.medGray,
    });
    const vw = font.widthOfTextAtSize(value, size);
    page.drawText(value, {
      x: rightX - vw, y: builder.y, size, font, color: theme.color.text,
    });
    builder.y -= lineH;
  };

  if (config.subtotal !== undefined) {
    drawRow("Subtotal", formatAccountingNumber(config.subtotal, currency), false);
  }
  if (config.discount !== undefined && config.discount > 0) {
    drawRow("Discount", formatAccountingNumber(-config.discount, currency), false);
  }
  if (config.tax !== undefined && config.tax > 0) {
    drawRow("Tax", formatAccountingNumber(config.tax, currency), false);
  }
  if (config.extraLines) {
    for (const l of config.extraLines) {
      drawRow(l.label, formatAccountingNumber(l.negate ? -l.value : l.value, currency), false);
    }
  }

  // Single rule above grand total. Draw the rule ABOVE the TOTAL row's
  // ascender line — never inside the glyph body — so the label is not
  // struck through on 80mm / 58mm receipts. lineH=11, bold size=9, so we
  // budget 3pt of clearance between the rule and the TOTAL text top.
  builder.y -= 6; // gap after last summary row
  builder.ensureSpace(lineH + 12);
  page.drawLine({
    start: { x: leftX, y: builder.y },
    end: { x: rightX, y: builder.y },
    thickness: 0.75, color: theme.color.text,
  });
  builder.y -= 11; // ascender + gap so rule sits above TOTAL glyphs, not through them
  drawRow("TOTAL", formatAccountingNumber(config.total, currency), true);

  if (config.amountPaid !== undefined) {
    drawRow("Paid", formatAccountingNumber(-Math.abs(config.amountPaid), currency), false);
  }
  if (config.balanceDue !== undefined && Math.abs(config.balanceDue) > 0.005) {
    drawRow("Balance", formatAccountingNumber(config.balanceDue, currency), true);
  }
  builder.y -= 4;
}
