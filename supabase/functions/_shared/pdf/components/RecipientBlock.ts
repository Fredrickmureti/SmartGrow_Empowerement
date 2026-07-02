/**
 * RecipientBlock — "Statement To:" block on the left, "Amount Due:" on the right.
 * Used by customer/vendor statements rendered through the report PDF pipeline.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";

export interface RecipientInfo {
  name: string;
  company?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  email?: string;
  accountRef?: string;
}

export interface RecipientBlockConfig {
  recipient: RecipientInfo;
  /** Optional formatted amount-due string, drawn in the top-right. */
  amountDue?: string;
  /** Y of the page-header separator line (for amount-due vertical alignment). */
  separatorY: number;
}

/**
 * Draws the recipient block at the current builder.y, then a separator,
 * and updates builder.y to sit below the block ready for the table.
 */
export function drawRecipientBlock(
  builder: PdfBuilder,
  page: PDFPage,
  config: RecipientBlockConfig,
): void {
  // V2 (ADR-0008): on thermal/narrow paper, stack the recipient and amount-due
  // vertically — the wide layout right-aligns amountDue at `pageWidth - margin`
  // which falls off-canvas at 80mm/58mm.
  if (builder.state.density === "narrow") {
    drawNarrowRecipient(builder, page, config);
    return;
  }
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth, contentWidth } = state;
  const { recipient, amountDue, separatorY } = config;

  let y = builder.y;

  // Section label
  page.drawText("Statement To:", {
    x: margin, y, size: theme.size.sectionLabel, font: fontBold, color: theme.color.text,
  });
  y -= 14;

  // Recipient name
  page.drawText(recipient.name, {
    x: margin, y, size: theme.size.recipientName, font: fontBold, color: theme.color.text,
  });
  y -= 14;

  if (recipient.company && recipient.company !== recipient.name) {
    page.drawText(recipient.company, {
      x: margin, y, size: 9, font: fontRegular, color: theme.color.medGray,
    });
    y -= 12;
  }

  const lines: string[] = [];
  if (recipient.address) lines.push(recipient.address);
  const cityLine = [recipient.city, recipient.state, recipient.postalCode].filter(Boolean).join(", ");
  if (cityLine) lines.push(cityLine);
  if (recipient.country) lines.push(recipient.country);
  if (recipient.email) lines.push(recipient.email);
  if (recipient.accountRef) lines.push(`Account: ${recipient.accountRef}`);

  for (const line of lines) {
    page.drawText(line, {
      x: margin, y, size: theme.size.recipientLine, font: fontRegular, color: theme.color.medGray,
    });
    y -= 11;
  }

  // Amount Due (right-aligned, top of the recipient block area)
  if (amountDue) {
    const label = "Amount Due:";
    const labelW = fontBold.widthOfTextAtSize(label, theme.size.amountDueLabel);
    const rightX = pageWidth - margin;

    // Accountant safety: never let the amount overflow the right margin or
    // collide with the recipient block on the left. Shrink the font down to
    // a 7pt floor so every digit of a large balance remains visible.
    // The available slot is from `margin` (page left padding) all the way to
    // `rightX`, minus a generous left gutter to keep separation from the
    // recipient name.
    const RECIPIENT_GUTTER = 220; // reserve room on the left for the recipient
    const slotWidth = (pageWidth - margin) - (margin + RECIPIENT_GUTTER);
    let valueSize = theme.size.amountDueValue;
    while (
      fontBold.widthOfTextAtSize(amountDue, valueSize) > slotWidth &&
      valueSize > 7
    ) {
      valueSize -= 0.25;
    }
    const amountW = fontBold.widthOfTextAtSize(amountDue, valueSize);

    page.drawText(label, {
      x: rightX - Math.max(labelW, amountW),
      y: separatorY - 20,
      size: theme.size.amountDueLabel, font: fontBold, color: theme.color.text,
    });
    page.drawText(amountDue, {
      x: rightX - amountW,
      y: separatorY - 38,
      size: valueSize, font: fontBold, color: theme.color.text,
    });
  }

  // Separator
  y -= 6;
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 0.75, color: theme.color.border,
  });
  // Suppress unused-var warning for contentWidth (kept for future left/right block math)
  void contentWidth;

  // Use the shared blockGap so the line-items column header below has
  // guaranteed breathing room from the recipient/separator above.
  builder.y = y - theme.blockGap - 4;
}

/** Narrow (thermal) layout: full-width stacked, no right-aligned amount column. */
function drawNarrowRecipient(
  builder: PdfBuilder,
  page: PDFPage,
  config: RecipientBlockConfig,
): void {
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth } = state;
  const { recipient, amountDue } = config;

  let y = builder.y;
  page.drawText("Bill To:", {
    x: margin, y, size: 8, font: fontBold, color: theme.color.text,
  });
  y -= 11;

  if (recipient.name) {
    page.drawText(recipient.name, {
      x: margin, y, size: 8, font: fontBold, color: theme.color.text,
    });
    y -= 10;
  }
  if (recipient.company && recipient.company !== recipient.name) {
    page.drawText(recipient.company, {
      x: margin, y, size: 7, font: fontRegular, color: theme.color.medGray,
    });
    y -= 9;
  }
  const lines: string[] = [];
  if (recipient.address) lines.push(recipient.address);
  const cityLine = [recipient.city, recipient.state, recipient.postalCode].filter(Boolean).join(", ");
  if (cityLine) lines.push(cityLine);
  if (recipient.email) lines.push(recipient.email);
  if (recipient.accountRef) lines.push(`Acct: ${recipient.accountRef}`);
  for (const line of lines) {
    page.drawText(line, {
      x: margin, y, size: 7, font: fontRegular, color: theme.color.medGray,
    });
    y -= 9;
  }

  if (amountDue) {
    y -= 4;
    page.drawText("Amount Due:", {
      x: margin, y, size: 8, font: fontBold, color: theme.color.text,
    });
    y -= 11;
    page.drawText(amountDue, {
      x: margin, y, size: 10, font: fontBold, color: theme.color.text,
    });
    y -= 12;
  }

  y -= 4;
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageWidth - margin, y },
    thickness: 0.5, color: theme.color.border,
  });
  builder.y = y - 6;
}
