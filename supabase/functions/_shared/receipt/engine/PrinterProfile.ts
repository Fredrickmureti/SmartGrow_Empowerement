/**
 * PrinterProfile — single source of truth for paper width × font metrics.
 * Server mirror of src/lib/receipt/engine/PrinterProfile.ts. Keep in lockstep.
 */

export type PaperWidth = "40mm" | "58mm" | "80mm";
export type Font = "A" | "B";

export interface PrinterProfile {
  paper: PaperWidth;
  font: Font;
  columns: number;
  marginCols: number;
  caps: {
    auto_cut: boolean;
    partial_cut: boolean;
    qr_native: boolean;
    code128_native: boolean;
  };
}

// Conservative physical defaults. A real printer profile may still widen the
// grid via columns_override, but the server must never assume an 80mm printer
// can safely render 64 columns just because the settings ask for a smaller
// font — that speculation is what causes emulator overflow on common devices.
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

export function contentWidth(p: PrinterProfile): number {
  return Math.max(8, p.columns - 2 * p.marginCols);
}
