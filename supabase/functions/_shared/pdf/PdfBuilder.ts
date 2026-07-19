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
export type PaperPreset = "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm";

/** Explicit paper dimensions in millimetres.
 *
 *  `heightMm: "continuous"` means "continuous roll" — width is fixed by the
 *  profile, height is auto-sized by the renderer to the consumed content
 *  (single page only). This is the correct model for thermal receipts,
 *  matching Odoo `paperformat` with `page_height=0`, SAP POS DM receipts,
 *  Xstore ReceiptDoc, and Toast/Square/Shopify POS receipt renderers.
 *
 *  `heightMm: "auto"` is retained as a deprecated alias for `"continuous"`
 *  for one release; new code should use `"continuous"`.
 */
export interface PaperSpec {
  widthMm: number;
  heightMm: number | "continuous" | "auto";
}

const MM_TO_PT = 72 / 25.4;

/** Provisional page height (in points) used while rendering continuous
 *  media. Large enough to fit any reasonable single receipt (~1 metre of
 *  paper) but not so large that pdf-lib allocates absurd coordinate space. */
const CONTINUOUS_PROVISIONAL_PT = 3000;

const PRESETS: Record<PaperPreset, PaperSpec> = {
  a4: { widthMm: 210, heightMm: 297 },
  letter: { widthMm: 215.9, heightMm: 279.4 },
  a5: { widthMm: 148, heightMm: 210 },
  // Thermal presets — continuous roll, height auto-sized to content
  // (ADR-0008 Phase T1). Previously seeded with `heightMm: 297`, which
  // caused thermal PDFs to render as tall blank strips with content at
  // the very top — that is the defect this phase closes.
  "80mm": { widthMm: 80, heightMm: "continuous" },
  "58mm": { widthMm: 58, heightMm: "continuous" },
  "40mm": { widthMm: 40, heightMm: "continuous" },
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
  /** Height mode. `"continuous"` means the final page will be cropped to
   *  consumed content at save() time (thermal receipts / ADR-0008 T1). */
  heightMode: "fixed" | "continuous";
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
    // Continuous-height paper (ADR-0008 T1): render into a tall provisional
    // page; save() crops the media box down to consumed content.
    const isContinuous = paper.heightMm === "continuous"
      || paper.heightMm === "auto";

    const heightMode: "fixed" | "continuous" = isContinuous ? "continuous" : "fixed";
    const baseW = paper.widthMm * MM_TO_PT;
    const baseH = isContinuous
      ? CONTINUOUS_PROVISIONAL_PT
      : (paper.heightMm as number) * MM_TO_PT;
    // Continuous strips are portrait by definition (a landscape orientation
    // makes no physical sense on a roll printer); ignore the landscape flag.
    const pageWidth = (isLandscape && !isContinuous) ? baseH : baseW;
    const pageHeight = (isLandscape && !isContinuous) ? baseW : baseH;

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
      heightMode,
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
