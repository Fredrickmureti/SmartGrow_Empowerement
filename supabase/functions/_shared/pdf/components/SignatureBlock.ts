/**
 * SignatureBlock — signatory panels for HR letters (offer, contract,
 * promotion, warning) and any document requiring a legally-binding
 * signature line.
 *
 * Phase 6.1 (ADR-0084). Renders one or two side-by-side signatory
 * cells, each with:
 *   - Signature line (underline)
 *   - Optional pre-rendered signature image (data URL / PNG bytes)
 *   - Printed name
 *   - Role / title
 *   - Optional signed-on date
 *
 * The block is layout-only: it does NOT fetch or validate signatures.
 * The caller (fetcher in `generate-document`) resolves signatory data
 * and passes it in. All colors and typography come from the shared
 * theme so HR letters stay visually consistent with sales documents.
 */

import { PDFPage, PDFImage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";

export interface Signatory {
  /** Legal name printed under the signature line. */
  name: string;
  /** Role / title / relationship (e.g. "HR Director", "Employee"). */
  role?: string;
  /** ISO date string; rendered under the role when present. */
  signedOn?: string;
  /** Optional PNG bytes for a pre-scanned signature image. */
  signatureImage?: PDFImage | null;
  /** Optional caption above the signature line (default: "Signature"). */
  caption?: string;
}

export interface SignatureBlockConfig {
  signatories: Signatory[];
  /** Optional heading above the signature panels. */
  title?: string;
  /** Extra vertical padding above the block. Defaults to 18pt. */
  topPadding?: number;
}

const CELL_HEIGHT = 78;
const LINE_INSET = 6;

export function drawSignatureBlock(
  builder: PdfBuilder,
  page: PDFPage,
  config: SignatureBlockConfig,
): void {
  const signatories = config.signatories.filter((s) => s && s.name);
  if (signatories.length === 0) return;

  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;
  const isNarrow = state.density === "narrow";
  const labelSize = isNarrow ? 7 : 8;
  const nameSize = isNarrow ? 8 : 10;
  const metaSize = isNarrow ? 6 : 7;

  const topPad = config.topPadding ?? 18;
  builder.ensureSpace(topPad + CELL_HEIGHT + (config.title ? 16 : 0));
  builder.y -= topPad;

  if (config.title) {
    page.drawText(config.title, {
      x: margin,
      y: builder.y,
      size: isNarrow ? 8 : theme.size.amountDueLabel,
      font: fontBold,
      color: theme.color.text,
    });
    builder.y -= 14;
  }

  // Two-up on wide paper, stacked on thermal.
  const perRow = isNarrow ? 1 : Math.min(signatories.length, 2);
  const gap = 24;
  const cellW = (contentWidth - gap * (perRow - 1)) / perRow;

  let index = 0;
  while (index < signatories.length) {
    builder.ensureSpace(CELL_HEIGHT + 4);
    const rowTopY = builder.y;
    for (let col = 0; col < perRow && index < signatories.length; col++, index++) {
      const s = signatories[index];
      const x = margin + col * (cellW + gap);
      let y = rowTopY;

      // Optional signature image sits above the line.
      if (s.signatureImage) {
        try {
          const imgH = 28;
          const scaled = s.signatureImage.scaleToFit(cellW - LINE_INSET * 2, imgH);
          builder.page.drawImage(s.signatureImage, {
            x: x + LINE_INSET,
            y: y - scaled.height + 4,
            width: scaled.width,
            height: scaled.height,
          });
        } catch {
          /* ignore corrupt image bytes — line still renders below */
        }
      }

      // Signature line.
      const lineY = y - 32;
      builder.page.drawLine({
        start: { x: x + LINE_INSET, y: lineY },
        end: { x: x + cellW - LINE_INSET, y: lineY },
        thickness: 0.6,
        color: theme.color.text,
      });

      // Caption ("Signature") — small label just under the line.
      const caption = s.caption ?? "Signature";
      builder.page.drawText(caption, {
        x: x + LINE_INSET,
        y: lineY - labelSize - 2,
        size: labelSize,
        font: fontRegular,
        color: theme.color.medGray,
      });

      // Printed name.
      const nameY = lineY - labelSize - nameSize - 8;
      builder.page.drawText(s.name, {
        x: x + LINE_INSET,
        y: nameY,
        size: nameSize,
        font: fontBold,
        color: theme.color.text,
      });

      // Role.
      let metaY = nameY - metaSize - 4;
      if (s.role) {
        builder.page.drawText(s.role, {
          x: x + LINE_INSET,
          y: metaY,
          size: metaSize,
          font: fontRegular,
          color: theme.color.medGray,
        });
        metaY -= metaSize + 2;
      }
      if (s.signedOn) {
        builder.page.drawText(`Signed: ${s.signedOn}`, {
          x: x + LINE_INSET,
          y: metaY,
          size: metaSize,
          font: fontRegular,
          color: theme.color.medGray,
        });
      }
    }
    builder.y = rowTopY - CELL_HEIGHT;
  }

  builder.y -= 8;
}