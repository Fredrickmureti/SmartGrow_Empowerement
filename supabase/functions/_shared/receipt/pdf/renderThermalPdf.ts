/**
 * renderThermalPdf — flow-based, engine-driven thermal-receipt PDF.
 *
 * Consumes the exact `ReceiptLinesResult` produced by
 * `../lines.ts#buildReceiptLines`. Every row is emitted at a fixed
 * cell width using an embedded monospace font (Courier), so the printed
 * PDF is a pixel-faithful facsimile of both the on-screen monospace
 * preview and the ESC/POS byte stream emitted by `builder.ts`.
 *
 * Rules (deterministic — no coordinate math in the caller):
 *   • Page WIDTH  = paper millimetres × 2.83465 pt/mm.
 *   • Page HEIGHT = measured content height (continuous roll).
 *   • Font        = Courier (Font B / A both approximated by
 *                  bold vs regular; large rows use double height).
 *   • Row height  = fontSize * lineHeightMultiplier.
 *   • Column grid = `result.columns` cells, each `cellWidthPt` wide,
 *                  computed from the paper width minus the physical margin.
 *
 * NO shared component with `generateDocumentPdf` (the A4 pipeline). The
 * two renderers are structurally orthogonal.
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "https://esm.sh/pdf-lib@1.17.1";
import type { ReceiptLinesResult } from "../lines.ts";
import { paperGeometry } from "../engine/PrinterProfile.ts";

const MM_TO_PT = 2.83465;

export interface RenderThermalPdfOptions {
  /** Base font size in points. 9 fits 48 cols in 80mm; 7 for 58/40mm. */
  fontSize?: number;
  /** Row vertical multiple of `fontSize`. Default 1.2. */
  lineHeight?: number;
  /** Top/bottom paper padding in mm. Default 4. */
  paperPaddingMm?: number;
}

function pickFontSize(paper: ReceiptLinesResult["paper"], columns: number): number {
  // Solve: cellWidthPt = (paperWidthMm - 2*marginMm) * MM_TO_PT / columns
  // Courier's character width ≈ 0.6 * fontSize, so fontSize ≈ cellWidthPt / 0.6
  const usableMm = PAPER_WIDTH_MM[paper] - 2 * PAPER_MARGIN_MM[paper];
  const cellPt = (usableMm * MM_TO_PT) / columns;
  const size = cellPt / 0.6;
  // Clamp to sane thermal range.
  return Math.max(6, Math.min(11, +size.toFixed(2)));
}

export async function renderThermalPdf(
  result: ReceiptLinesResult,
  options: RenderThermalPdfOptions = {},
): Promise<Uint8Array> {
  const {
    fontSize = pickFontSize(result.paper, result.columns),
    lineHeight = 1.2,
    paperPaddingMm = 4,
  } = options;

  const paperWidthPt = PAPER_WIDTH_MM[result.paper] * MM_TO_PT;
  const paperMarginPt = PAPER_MARGIN_MM[result.paper] * MM_TO_PT;
  const usableWidthPt = paperWidthPt - 2 * paperMarginPt;
  const cellWidthPt = usableWidthPt / result.columns;
  const rowHeightPt = fontSize * lineHeight;
  const largeRowHeightPt = fontSize * lineHeight * 1.5;
  const topPad = paperPaddingMm * MM_TO_PT;
  const bottomPad = paperPaddingMm * MM_TO_PT;

  // First pass — measure total height so the page fits exactly (continuous roll).
  let heightPt = topPad + bottomPad;
  for (const m of result.meta) {
    if (m.qr) heightPt += usableWidthPt * 0.55; // QR block ≈ 55% of paper width
    else heightPt += m.large ? largeRowHeightPt : rowHeightPt;
  }

  const pdf = await PDFDocument.create();
  const courier = await pdf.embedFont(StandardFonts.Courier);
  const courierBold = await pdf.embedFont(StandardFonts.CourierBold);

  const page = pdf.addPage([paperWidthPt, heightPt]);

  let y = heightPt - topPad;
  for (let i = 0; i < result.lines.length; i++) {
    const text = result.lines[i];
    const m = result.meta[i];
    const rowH = m.large ? largeRowHeightPt : rowHeightPt;

    if (m.qr) {
      drawQrPlaceholder(page, {
        x: paperMarginPt,
        y: y - usableWidthPt * 0.55,
        size: usableWidthPt * 0.55,
        centerX: paperWidthPt / 2,
      });
      y -= usableWidthPt * 0.55;
      continue;
    }

    y -= rowH;
    const font: PDFFont = m.bold || m.large ? courierBold : courier;
    const drawSize = m.large ? fontSize * 1.3 : fontSize;
    const yBaseline = y + (rowH - drawSize) / 2;

    if (m.rule) {
      // Draw a real thin rule instead of dashes for a cleaner PDF look.
      const ruleY = yBaseline + drawSize / 2 - 0.2;
      page.drawLine({
        start: { x: paperMarginPt, y: ruleY },
        end:   { x: paperWidthPt - paperMarginPt, y: ruleY },
        thickness: 0.4,
        color: rgb(0.15, 0.15, 0.15),
      });
      continue;
    }

    if (!text) continue;

    let drawX: number;
    if (m.align === "left") {
      // Row is pre-padded with marginCols spaces; draw at paper margin
      // and use fixed cellWidth so alignment holds.
      drawX = paperMarginPt;
    } else if (m.align === "center") {
      const textWidth = text.length * cellWidthPt;
      drawX = (paperWidthPt - textWidth) / 2;
    } else {
      // right
      const textWidth = text.length * cellWidthPt;
      drawX = paperWidthPt - paperMarginPt - textWidth;
    }

    // Draw character-by-character so monospace grid is guaranteed even if
    // the embedded font's metrics disagree marginally with 0.6em.
    for (let c = 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === " ") continue;
      page.drawText(ch, {
        x: drawX + c * cellWidthPt,
        y: yBaseline,
        size: drawSize,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }

  return await pdf.save();
}

function drawQrPlaceholder(
  page: PDFPage,
  opts: { x: number; y: number; size: number; centerX: number },
) {
  const { y, size, centerX } = opts;
  const x = centerX - size / 2;
  page.drawRectangle({
    x,
    y,
    width: size,
    height: size,
    borderColor: rgb(0.2, 0.2, 0.2),
    borderWidth: 0.6,
  });
  // Simple corner markers so it reads as a QR-shaped block in PDF.
  const m = size * 0.18;
  const corners: Array<[number, number]> = [
    [x, y + size - m],
    [x + size - m, y + size - m],
    [x, y],
  ];
  for (const [cx, cy] of corners) {
    page.drawRectangle({
      x: cx,
      y: cy,
      width: m,
      height: m,
      color: rgb(0, 0, 0),
    });
    page.drawRectangle({
      x: cx + m * 0.28,
      y: cy + m * 0.28,
      width: m * 0.44,
      height: m * 0.44,
      color: rgb(1, 1, 1),
    });
  }
}