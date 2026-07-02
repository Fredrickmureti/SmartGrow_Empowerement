/**
 * NotesBlock — left-aligned titled paragraph used for Notes, Terms,
 * Payment Instructions, and Bank Details on sales documents.
 *
 * Wraps text on word boundaries, paginates automatically through
 * builder.ensureSpace, and uses theme typography.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";

export interface NotesBlockConfig {
  title: string;
  body: string;
  /** Optional max width override (defaults to full content width). */
  maxWidth?: number;
}

export function drawNotesBlock(
  builder: PdfBuilder,
  page: PDFPage,
  config: NotesBlockConfig,
): void {
  if (!config.body || !config.body.trim()) return;

  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;
  const isNarrow = state.density === "narrow";
  const maxWidth = config.maxWidth ?? contentWidth;
  // V2 (ADR-0008): tighter typography on thermal paper.
  const fontSize = isNarrow ? 7 : theme.size.orgDetail; // 8pt → 7pt
  const lineHeight = isNarrow ? 9 : 11;

  // Reserve initial header + first line
  builder.ensureSpace(lineHeight + 14);

  // Title
  page.drawText(config.title, {
    x: margin, y: builder.y,
    size: isNarrow ? 8 : theme.size.amountDueLabel, font: fontBold, color: theme.color.text,
  });
  builder.y -= lineHeight + 2;

  // Word-wrap body
  const paragraphs = config.body.split("\n");
  const spaceWidth = fontRegular.widthOfTextAtSize(" ", fontSize);

  for (const para of paragraphs) {
    if (!para.trim()) {
      builder.y -= lineHeight;
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let currentLine = "";
    let currentWidth = 0;

    const flush = (text: string) => {
      builder.ensureSpace(lineHeight);
      // After a page break, page reference may be stale; pull current.
      builder.page.drawText(text, {
        x: margin, y: builder.y,
        size: fontSize, font: fontRegular, color: theme.color.medGray,
      });
      builder.y -= lineHeight;
    };

    for (const word of words) {
      const wordW = fontRegular.widthOfTextAtSize(word, fontSize);
      if (currentWidth === 0) {
        currentLine = word;
        currentWidth = wordW;
      } else if (currentWidth + spaceWidth + wordW > maxWidth) {
        flush(currentLine);
        currentLine = word;
        currentWidth = wordW;
      } else {
        currentLine += " " + word;
        currentWidth += spaceWidth + wordW;
      }
    }
    if (currentLine) flush(currentLine);
  }

  builder.y -= 6;
}
