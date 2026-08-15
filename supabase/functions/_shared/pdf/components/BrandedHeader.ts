/**
 * BrandedHeader — masthead drawn at the top of every page.
 *
 * Layout (matches existing financial-report layout exactly):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [logo]                              <Title>             │
 *   │ Org Name                            Date Range          │
 *   │ Address                             Generated: ...      │
 *   │ City, State                                              │
 *   │ Phone                                                    │
 *   │ Email                                                    │
 *   │ Tax ID                                                   │
 *   │ ─────────────────────────────────────────────────────── │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Returns the Y position immediately below the separator, ready for
 * the body to start drawing.
 */

import { PDFImage, PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import {
  DOCUMENT_TYPOGRAPHY,
  type Typography,
} from "../themes/presentation.ts";
import { winansiSafe } from "../winansi.ts";
import type { OrganizationBranding } from "../../branding/index.ts";

export interface BrandedHeaderConfig {
  title: string;
  dateRange?: string;
  /**
   * Point-in-time reports (Trial Balance, Balance Sheet). Mutually
   * exclusive with `dateRange`: the masthead renders "As of <asOf>"
   * instead of "For the period <dateRange>".
   */
  asOf?: string;
  /**
   * Reporting scope line — "<Business> · <Branch>". Derived ONCE from the
   * resolved business identity by `renderReport`; reports never compose
   * their own scope string.
   */
  scope?: string;
  organization?: OrganizationBranding | null;
  /** Fallback when organization is missing. */
  companyName?: string;
  /** Pre-embedded logo image + scaled dimensions (callers embed once). */
  logo?: { image: PDFImage; width: number; height: number } | null;
  /** Override the generation timestamp (defaults to builder's). */
  generatedStamp?: string;
  /**
   * Stage 3: layout style.
   *   - "operational" (default): logo left, title right (existing layout).
   *   - "financial": centered statutory masthead in the order
   *       LOGO → COMPANY NAME → Title → Period/As-of → Basis → Scope →
   *       Prepared on.
   *     The logo is part of the legal entity's document identity, so it is
   *     rendered in BOTH profiles (centered here, left-aligned there).
   */
  formatProfile?: "operational" | "financial";
  /** Optional subtitle (financial profile only, e.g. "Accrual Basis"). */
  subtitle?: string;
  /**
   * Resolved presentation tokens. Omitted = document profile (unchanged
   * transactional-document masthead).
   */
  typography?: Typography;
}


export interface DrawnHeader {
  /** Y position below the separator line — body starts here. */
  bodyY: number;
  /** Y position of the separator line itself (for amount-due alignment). */
  separatorY: number;
}

/**
 * Embed an organization logo, returning the embedded image and the
 * pdf-lib-scaled dimensions (constrained to theme.logoMaxW/H).
 *
 * Caller is responsible for fetching bytes via fetchLogoBytes().
 * Returns null on any failure (missing bytes, invalid image, etc.).
 */
export async function embedLogo(
  builder: PdfBuilder,
  bytes: Uint8Array | null,
): Promise<{ image: PDFImage; width: number; height: number } | null> {
  if (!bytes) return null;
  let image: PDFImage | null = null;
  try {
    image = await builder.doc.embedPng(bytes);
  } catch {
    try {
      image = await builder.doc.embedJpg(bytes);
    } catch (e) {
      console.warn("[BrandedHeader] logo embed failed:", (e as Error).message);
      return null;
    }
  }
  if (!image) return null;
  const scale = Math.min(theme.logoMaxW / image.width, theme.logoMaxH / image.height);
  return {
    image,
    width: image.width * scale,
    height: image.height * scale,
  };
}

export function drawBrandedHeader(
  builder: PdfBuilder,
  page: PDFPage,
  config: BrandedHeaderConfig,
): DrawnHeader {
  // V2 (ADR-0008): on thermal/narrow paper, draw a single-column stacked
  // masthead. The wide layout's right-aligned title and bottom-right
  // generation stamp would render off-canvas at 80mm/58mm.
  if (builder.state.density === "narrow") {
    return drawNarrowHeader(builder, page, config);
  }
  // Product decision (2026-08): ALL reports — statutory statements
  // included — use one masthead: logo top-left, entity block left,
  // title / period / generated-on right. `formatProfile` still drives
  // typography + wording ("As of ..."), never the header layout, so no
  // single document can drift into a different-looking header again.
  // `drawFinancialMasthead` is retained below for reference only.
  return drawOperationalHeader(builder, page, config);
}



/**
 * Narrow (thermal) masthead — everything stacked, centered, single column.
 * Skips logo (rarely fits readably on 58mm) and tax-id/email lines that
 * push the receipt past one screen of paper. Keeps title + org name +
 * one address line + phone.
 */
function drawNarrowHeader(
  builder: PdfBuilder,
  page: PDFPage,
  config: BrandedHeaderConfig,
): DrawnHeader {
  const { state, fontRegular, fontBold } = builder;
  const { pageWidth, pageHeight, margin } = state;
  const { title, organization, companyName } = config;
  const stamp = config.generatedStamp ?? state.generatedStamp;

  const orgName = organization?.name || companyName || "";
  const center = pageWidth / 2;
  const drawCentered = (
    text: string,
    y: number,
    size: number,
    bold: boolean,
    color = theme.color.text,
  ) => {
    if (!text) return;
    const font = bold ? fontBold : fontRegular;
    // Truncate (not shrink) — narrow paper has hard width limits.
    let t = winansiSafe(text);
    const maxW = pageWidth - margin * 2;
    while (font.widthOfTextAtSize(t, size) > maxW && t.length > 1) {
      t = t.slice(0, -1);
    }
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: center - w / 2, y, size, font, color });
  };

  let y = pageHeight - margin;

  if (orgName) {
    drawCentered(orgName, y, 10, true);
    y -= 12;
  }

  // One address line if present (city only — full address rarely fits).
  const cityLine = [organization?.city, organization?.state].filter(Boolean).join(", ");
  if (cityLine) {
    drawCentered(cityLine, y, 7, false, theme.color.medGray);
    y -= 9;
  }
  if (organization?.phone) {
    drawCentered(organization.phone, y, 7, false, theme.color.medGray);
    y -= 9;
  }

  // Title centered, bigger.
  y -= 2;
  drawCentered(title.toUpperCase(), y, 9, true);
  y -= 12;

  drawCentered(stamp, y, 6, false, theme.color.lightGray);
  y -= 8;

  const separatorY = y - 2;
  page.drawLine({
    start: { x: margin, y: separatorY },
    end: { x: pageWidth - margin, y: separatorY },
    thickness: 0.5,
    color: theme.color.text,
  });

  return { bodyY: separatorY - 10, separatorY };
}

/**
 * Original logo-left / title-right layout. Used for invoices, statements,
 * operational reports, ageing, etc.
 */
function drawOperationalHeader(
  builder: PdfBuilder,
  page: PDFPage,
  config: BrandedHeaderConfig,
): DrawnHeader {
  const { state, fontRegular, fontBold } = builder;
  const { pageWidth, pageHeight, margin } = state;
  const { title, dateRange, asOf, scope, subtitle, organization, companyName, logo } = config;
  const t = config.typography ?? DOCUMENT_TYPOGRAPHY;
  const stamp = config.generatedStamp ?? state.generatedStamp;

  const orgName = organization?.name || companyName || "";
  const topY = pageHeight - margin;

  if (logo) {
    page.drawImage(logo.image, {
      x: margin,
      y: topY - logo.height,
      width: logo.width,
      height: logo.height,
    });
  }

  let infoY = logo ? topY - logo.height - 14 : topY;

  if (orgName) {
    page.drawText(winansiSafe(orgName), {
      x: margin, y: infoY,
      size: t.size.orgName, font: fontBold, color: theme.color.text,
    });
    infoY -= 14;
  }

  const orgDetails: string[] = [];
  if (organization?.address) orgDetails.push(organization.address);
  const cityLine = [organization?.city, organization?.state, organization?.country]
    .filter(Boolean)
    .join(", ");
  if (cityLine) orgDetails.push(cityLine);
  if (organization?.phone) orgDetails.push(organization.phone);
  if (organization?.email) orgDetails.push(organization.email);
  if (organization?.tax_id) orgDetails.push(`Tax ID: ${organization.tax_id}`);

  for (const detail of orgDetails) {
    page.drawText(winansiSafe(detail), {
      x: margin, y: infoY,
      size: t.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    infoY -= 11;
  }

  const safeTitle = winansiSafe(title);
  const titleSize = safeTitle.length > 25 ? t.size.titleSmall : t.size.title;
  const titleWidth = fontBold.widthOfTextAtSize(safeTitle, titleSize);
  page.drawText(safeTitle, {
    x: pageWidth - margin - titleWidth,
    y: topY,
    size: titleSize, font: fontBold, color: theme.color.text,
  });

  // Statement identity block, right-aligned under the title. A statement
  // must be self-identifying (IAS 1): period covered, basis of preparation
  // and reporting scope — the same lines the on-screen ReportSurface shows.
  // Previously `asOf`, `subtitle` and `scope` were resolved by renderReport
  // and then silently dropped here, so the download said less than the
  // screen.
  const periodLine = asOf
    ? (/^as of/i.test(asOf) ? asOf : `As of ${asOf}`)
    : dateRange
      ? (/^(as of|for the period)/i.test(dateRange)
          ? dateRange
          : `For the period ${dateRange}`)
      : "";

  const metaLines: { text: string; size: number; color: typeof theme.color.medGray }[] = [];
  if (periodLine) {
    metaLines.push({ text: periodLine, size: t.size.dateRange, color: theme.color.medGray });
  }
  if (subtitle) {
    metaLines.push({ text: subtitle, size: t.size.orgDetail, color: theme.color.medGray });
  }
  if (scope) {
    metaLines.push({ text: scope, size: t.size.orgDetail, color: theme.color.medGray });
  }
  metaLines.push({ text: stamp, size: t.size.timestamp, color: theme.color.lightGray });

  let metaY = topY - 20;
  for (const line of metaLines) {
    const safeLine = winansiSafe(line.text);
    const w = fontRegular.widthOfTextAtSize(safeLine, line.size);
    page.drawText(safeLine, {
      x: pageWidth - margin - w,
      y: metaY,
      size: line.size, font: fontRegular, color: line.color,
    });
    metaY -= line.size + 4;
  }

  // Separator clears BOTH columns: the entity block on the left and the
  // (now variable-height) identity block on the right.
  const separatorY = Math.min(infoY, metaY + 2, topY - 48) - 8;
  page.drawLine({
    start: { x: margin, y: separatorY },
    end: { x: pageWidth - margin, y: separatorY },
    thickness: 1.5,
    color: theme.color.text,
  });

  return { bodyY: separatorY - 16, separatorY };
}

/**
 * Statutory financial-statement masthead — centered, in the order
 * accountants expect:
 *   1. Business logo (centered, when the legal entity has one)
 *   2. COMPANY NAME (uppercase, bold)
 *   3. Report title (bold)
 *   4. Period ("For the period …") OR As-of ("As of …")
 *   5. Optional basis subtitle (e.g. "Accrual Basis")
 *   6. Reporting scope ("<Business> · <Branch>")
 *   7. Prepared on {timestamp}
 *
 * This matches the on-screen `ReportSurface` masthead, so preview and
 * printed PDF read identically.
 */
// Retained for reference: superseded by drawOperationalHeader for every report.
// deno-lint-ignore no-unused-vars
function drawFinancialMasthead(
  builder: PdfBuilder,
  page: PDFPage,
  config: BrandedHeaderConfig,
): DrawnHeader {
  const { state, fontRegular, fontBold } = builder;
  const { pageWidth, pageHeight, margin } = state;
  const { title, dateRange, asOf, scope, organization, companyName, subtitle, logo } = config;
  const t = config.typography ?? DOCUMENT_TYPOGRAPHY;
  const stamp = config.generatedStamp ?? state.generatedStamp;

  const orgName = (organization?.name || companyName || "").toUpperCase();
  const center = pageWidth / 2;

  const drawCentered = (
    text: string,
    y: number,
    size: number,
    bold: boolean,
    color = theme.color.text,
  ) => {
    if (!text) return;
    const font = bold ? fontBold : fontRegular;
    const safeText = winansiSafe(text);
    const w = font.widthOfTextAtSize(safeText, size);
    page.drawText(safeText, { x: center - w / 2, y, size, font, color });
  };

  let y = pageHeight - margin;

  // Legal-entity logo: identity, not decoration. Centered above the name,
  // capped so a tall logo can never push the statement body off the page.
  if (logo) {
    const maxH = Math.min(logo.height, 34);
    const scale = maxH / logo.height;
    const w = logo.width * scale;
    page.drawImage(logo.image, {
      x: center - w / 2,
      y: y - maxH,
      width: w,
      height: maxH,
    });
    y -= maxH + 8;
  }

  if (orgName) {
    drawCentered(orgName, y, t.size.orgName + 1, true);
    y -= 16;
  }

  drawCentered(title, y, t.size.title, true);
  y -= 14;

  // Point-in-time reports state an as-of date; range reports state a
  // period. Never both — the report registry / caller decides which.
  const periodLine = asOf
    ? (/^as of/i.test(asOf) ? asOf : `As of ${asOf}`)
    : dateRange
      ? (/^as of/i.test(dateRange) ? dateRange : `For the period ${dateRange}`)
      : "";
  if (periodLine) {
    drawCentered(periodLine, y, t.size.dateRange, false, theme.color.medGray);
    y -= 12;
  }

  if (subtitle) {
    drawCentered(subtitle, y, t.size.orgDetail, false, theme.color.medGray);
    y -= 11;
  }

  if (scope) {
    drawCentered(scope, y, t.size.orgDetail, false, theme.color.medGray);
    y -= 11;
  }

  drawCentered(stamp, y, t.size.timestamp, false, theme.color.lightGray);
  y -= 10;


  const separatorY = y - 6;
  page.drawLine({
    start: { x: margin, y: separatorY },
    end: { x: pageWidth - margin, y: separatorY },
    thickness: 1.5,
    color: theme.color.text,
  });

  return { bodyY: separatorY - 16, separatorY };
}
