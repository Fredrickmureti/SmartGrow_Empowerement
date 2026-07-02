/**
 * PdfBuilder — thin wrapper around pdf-lib that owns:
 *   - the document
 *   - the Helvetica fonts
 *   - the page dimensions / margins
 *   - the cursor (current Y position)
 *   - the page-break loop (newPage() callback)
 *
 * Components (BrandedHeader, DataTable, etc.) take a PdfBuilder and draw
 * onto its current page through the supplied helpers — they never touch
 * pdf-lib directly. This is what lets us share rendering logic across
 * financial reports, sales documents, payslips, and audit certificates.
 *
 * Stage P1 (printing-architecture overhaul, ADR-0008): the builder is now
 * paper-agnostic — `paperFormat` accepts named presets (`a4`, `letter`,
 * `a5`, `80mm`, `58mm`) or an explicit `{ widthMm, heightMm }` spec. The
 * legacy `pageSize: "a4" | "letter"` argument continues to work as an
 * alias so every existing call site keeps producing identical output.
 *
 * Components read `state.density` to decide between wide-table layout
 * (A4 / Letter) and narrow stacked layout (thermal). The default density
 * is derived from the page width — anything ≤ 90 mm is `narrow`.
 */

import { PDFDocument, PDFPage, PDFFont, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import { theme } from "./themes/accountantMono.ts";
import { formatGeneratedStamp } from "../format/index.ts";

export type Orientation = "portrait" | "landscape";

/** Legacy alias kept for backward compatibility with pre-Stage-P1 callers. */
export type PageSize = "letter" | "a4";

/** Display density consumed by line-item / totals / recipient components. */
export type Density = "wide" | "narrow";

/** Named paper presets recognised by the builder. */
export type PaperPreset = "a4" | "letter" | "a5" | "80mm" | "58mm";

/** Explicit paper dimensions in millimetres. `heightMm: "auto"` is reserved
 *  for future continuous-receipt support and is currently treated as 297 mm
 *  (A4 height) so existing renderers never break. */
export interface PaperSpec {
  widthMm: number;
  heightMm: number | "auto";
}

const MM_TO_PT = 72 / 25.4;

const PRESETS: Record<PaperPreset, PaperSpec> = {
  a4: { widthMm: 210, heightMm: 297 },
  letter: { widthMm: 215.9, heightMm: 279.4 },
  a5: { widthMm: 148, heightMm: 210 },
  "80mm": { widthMm: 80, heightMm: 297 },
  "58mm": { widthMm: 58, heightMm: 297 },
};

export function resolvePaperSpec(input: PaperPreset | PaperSpec | undefined): PaperSpec {
  if (!input) return PRESETS.a4;
  if (typeof input === "string") return PRESETS[input] ?? PRESETS.a4;
  return input;
}

export interface PdfBuilderOptions {
  orientation?: Orientation;
  /** New paper-agnostic field. Accepts a preset name or explicit mm spec. */
  paperFormat?: PaperPreset | PaperSpec;
  /** Legacy field — retained as an alias for `paperFormat`. */
  pageSize?: PageSize;
  /** Override the default page margin (in points). Auto-shrinks for thermal. */
  margin?: number;
  /** Override the auto-derived density. */
  density?: Density;
}

export interface BuilderState {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  bottomMargin: number;
  contentWidth: number;
  pageNum: number;
  generatedAt: Date;
  generatedStamp: string;
  /** "narrow" on thermal widths (≤ ~90 mm of paper); "wide" otherwise. */
  density: Density;
  /** Resolved paper spec for downstream components / debugging. */
  paper: PaperSpec;
}

export class PdfBuilder {
  readonly doc: PDFDocument;
  readonly fontRegular: PDFFont;
  readonly fontBold: PDFFont;
  readonly state: BuilderState;

  /** Currently active page. Components draw onto this. */
  page!: PDFPage;
  /** Current Y cursor (drops as we render). */
  y: number;

  /**
   * Optional callback fired every time a new page is started.
   * Used by the BrandedHeader to redraw header on each page and
   * return the post-header Y position.
   */
  onNewPage?: (page: PDFPage) => number;

  private constructor(
    doc: PDFDocument,
    fontRegular: PDFFont,
    fontBold: PDFFont,
    state: BuilderState,
  ) {
    this.doc = doc;
    this.fontRegular = fontRegular;
    this.fontBold = fontBold;
    this.state = state;
    this.y = state.pageHeight - state.margin;
  }

  static async create(options: PdfBuilderOptions = {}): Promise<PdfBuilder> {
    const orientation: Orientation = options.orientation ?? "landscape";

    // Resolve paper: explicit `paperFormat` wins; otherwise honour the
    // legacy `pageSize` alias; default to letter (matches pre-Stage-P1).
    const paper: PaperSpec = options.paperFormat
      ? resolvePaperSpec(options.paperFormat)
      : resolvePaperSpec(options.pageSize ?? "letter");

    const isLandscape = orientation === "landscape";
    const heightMm = paper.heightMm === "auto" ? 297 : paper.heightMm;
    const baseW = paper.widthMm * MM_TO_PT;
    const baseH = heightMm * MM_TO_PT;
    const pageWidth = isLandscape ? baseH : baseW;
    const pageHeight = isLandscape ? baseW : baseH;

    // Density: explicit override > derived from paper width.
    // Anything ≤ 90 mm of paper goes narrow (covers 58mm and 80mm thermal).
    const density: Density = options.density
      ?? (paper.widthMm <= 90 ? "narrow" : "wide");

    // Margin: thermal needs a much smaller gutter than A4. Default theme
    // margin (50 pt) on an 80 mm receipt would consume more than half the
    // paper. Pick 6 pt for narrow, theme.pageMargin for wide.
    const margin = options.margin ?? (density === "narrow" ? 6 : theme.pageMargin);
    const bottomMargin = density === "narrow" ? 6 : theme.bottomMargin;

    const doc = await PDFDocument.create();
    const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const generatedAt = new Date();
    const state: BuilderState = {
      pageWidth,
      pageHeight,
      margin,
      bottomMargin,
      contentWidth: pageWidth - margin * 2,
      pageNum: 0,
      generatedAt,
      generatedStamp: `Report generated: ${formatGeneratedStamp(generatedAt)}`,
      density,
      paper,
    };

    return new PdfBuilder(doc, fontRegular, fontBold, state);
  }

  /**
   * Start a new page. Increments pageNum, resets cursor to top, and invokes
   * onNewPage (used by BrandedHeader to draw the masthead). The post-header
   * Y is stored on this.y.
   */
  newPage(): PDFPage {
    this.page = this.doc.addPage([this.state.pageWidth, this.state.pageHeight]);
    this.state.pageNum++;
    this.y = this.state.pageHeight - this.state.margin;
    if (this.onNewPage) {
      this.y = this.onNewPage(this.page);
    }
    return this.page;
  }

  /**
   * Reserve `needed` pts of vertical space on the current page; if not
   * available, start a new page (and return the new Y position).
   */
  ensureSpace(needed: number): void {
    if (this.y - needed < this.state.bottomMargin) {
      this.newPage();
    }
  }

  /** Total page count, for "Page n of m" stamping in finalize(). */
  get pageCount(): number {
    return this.state.pageNum;
  }

  async save(): Promise<Uint8Array> {
    return await this.doc.save();
  }
}
