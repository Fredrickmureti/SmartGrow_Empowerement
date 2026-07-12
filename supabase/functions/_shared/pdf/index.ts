/**
 * Public surface of the unified PDF rendering layer.
 *
 * Templates compose these primitives — they never import pdf-lib directly.
 */

export {
  PdfBuilder,
  resolvePaperSpec,
  type Orientation,
  type PageSize,
  type PaperPreset,
  type PaperSpec,
  type Density,
  type PdfBuilderOptions,
} from "./PdfBuilder.ts";
export { theme, type Theme } from "./themes/accountantMono.ts";

/**
 * STATUTORY PAPER PIN — runtime guard.
 *
 * Statutory documents (tax certificates, payroll returns, audit certificates,
 * payslips in regulated markets) are required by their issuing authority to
 * be A4 portrait. They MUST NOT be silently re-rendered on thermal or Letter
 * paper just because a tenant set a `document_print_policies` row to do so.
 *
 * Generators that emit statutory PDFs call `assertStatutoryPaper(received)`
 * at the top of the render path. If a caller has somehow forced a different
 * format, the helper throws — this is preferable to silently producing a
 * non-compliant filing.
 *
 * Pass the *resolved* paper format string (e.g. "a4" | "letter" | "80mm").
 * The default `allowed` set is just A4; pass an explicit list to widen it
 * for jurisdictions that accept Letter (none currently known).
 */
export function assertStatutoryPaper(
  received: string | undefined | null,
  allowed: readonly string[] = ["a4", "a4-landscape"],
): void {
  const normalized = (received ?? "a4").toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new Error(
      `Statutory paper pin violated: requested "${normalized}", allowed [${allowed.join(", ")}]. ` +
        `This document type is locked by regulator and cannot be re-papered.`,
    );
  }
}

export {
  drawBrandedHeader,
  embedLogo,
  type BrandedHeaderConfig,
  type DrawnHeader,
} from "./components/BrandedHeader.ts";

export {
  drawPageNumber,
  drawFinalFooter,
  type FooterConfig,
} from "./components/BrandedFooter.ts";

export {
  drawDataTable,
  type TableColumn,
  type TableRow,
  type RowMeta,
  type DataTableConfig,
} from "./components/DataTable.ts";

export {
  drawRecipientBlock,
  type RecipientInfo,
  type RecipientBlockConfig,
} from "./components/RecipientBlock.ts";

export {
  drawSummaryBlock,
  type SummaryItem,
} from "./components/SummaryBlock.ts";

export {
  drawTotalsBlock,
  type TotalsLine,
  type TotalsBlockConfig,
} from "./components/TotalsBlock.ts";

export {
  drawNotesBlock,
  type NotesBlockConfig,
} from "./components/NotesBlock.ts";

export {
  drawLineItemsTable,
  type LineItem,
  type LineItemsTableConfig,
} from "./components/LineItemsTable.ts";
