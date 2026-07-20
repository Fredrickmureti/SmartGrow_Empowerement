/**
 * PrinterProfile — single source of truth for paper width × font metrics.
 *
 * Replaces the previous hardcoded `COLS = { '58mm': 32, '80mm': 48 }` table
 * with a font-aware lookup. ESC/POS Font A (12-dot) and Font B (9-dot) yield
 * different column counts on the same paper. Margins are mandatory.
 */

export type PaperWidth = "40mm" | "58mm" | "80mm";
export type Font = "A" | "B";

export interface PrinterProfile {
  paper: PaperWidth;
  /** Default font when not overridden by a section. */
  font: Font;
  /** Total printable columns at the active font (NOT including margins). */
  columns: number;
  /** Spaces reserved on each side. Total content width = columns - 2*marginCols. */
  marginCols: number;
  /** Capability flags coerced upstream. */
  caps: {
    auto_cut: boolean;
    partial_cut: boolean;
    qr_native: boolean;
    code128_native: boolean;
  };
}

// Defaults — use conservative physical fallback widths unless an explicit
// printer profile provides measured columnsOverride. In practice many 80mm
// devices marketed as supporting a "small" font still behave like ~48-column
// printers in emulators / common ESC-POS firmwares, so we must not widen the
// grid speculatively and overflow the paper.
const FONT_COLUMNS: Record<PaperWidth, Record<Font, number>> = {
  "40mm": { A: 24, B: 32 },
  "58mm": { A: 32, B: 42 },
  "80mm": { A: 48, B: 48 },
};

const DEFAULT_MARGIN: Record<PaperWidth, number> = {
  "40mm": 1,
  "58mm": 1,
  "80mm": 2,
};

/**
 * Physical paper geometry — the single source of truth for millimetre
 * width and horizontal bleed margins used by media renderers (PDF, image
 * label, thermal preview). Character-grid math lives in `columns` /
 * `marginCols`; this table only governs how the character grid maps to
 * physical paper. Do NOT re-declare paper widths elsewhere.
 */
export interface PaperGeometry {
  /** Physical paper width in millimetres. */
  widthMm: number;
  /** Horizontal bleed inset (mm) outside the character grid to keep text
   *  off the thermal-head edge. Distinct from `marginCols` (grid-level). */
  marginMm: number;
}

const PAPER_GEOMETRY: Record<PaperWidth, PaperGeometry> = {
  "40mm": { widthMm: 40, marginMm: 1.5 },
  "58mm": { widthMm: 58, marginMm: 2 },
  "80mm": { widthMm: 80, marginMm: 3 },
};

export function paperGeometry(paper: PaperWidth): PaperGeometry {
  return PAPER_GEOMETRY[paper];
}

export interface ResolveProfileInput {
  paper: PaperWidth;
  font?: Font;
  marginCols?: number;
  columnsOverride?: number;
  caps?: Partial<PrinterProfile["caps"]>;
}

export function resolvePrinterProfile(input: ResolveProfileInput): PrinterProfile {
  const paper = input.paper;
  const font = input.font ?? "A";
  const baseColumns = input.columnsOverride && input.columnsOverride > 0
    ? Math.floor(input.columnsOverride)
    : FONT_COLUMNS[paper][font];
  const marginCols = Math.max(0, Math.min(4, input.marginCols ?? DEFAULT_MARGIN[paper]));
  return {
    paper,
    font,
    columns: baseColumns,
    marginCols,
    caps: {
      auto_cut: input.caps?.auto_cut ?? true,
      partial_cut: input.caps?.partial_cut ?? true,
      qr_native: input.caps?.qr_native ?? true,
      code128_native: input.caps?.code128_native ?? true,
    },
  };
}

/** Effective content width (after margins). */
export function contentWidth(p: PrinterProfile): number {
  return Math.max(8, p.columns - 2 * p.marginCols);
}
