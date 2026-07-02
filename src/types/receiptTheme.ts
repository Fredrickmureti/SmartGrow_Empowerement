/**
 * ReceiptTheme — Phase B.1 structured replacement for the flat
 * `ExtendedReceiptSettings` bag.
 *
 * Goals:
 *  - Group every receipt knob by SECTION, so the editor and the rendering
 *    engine speak the same language.
 *  - Add real layout capabilities the flat model couldn't express
 *    (`sectionOrder`, density preset, printer profile overrides).
 *  - Stay lossless against the flat model via `flatToTheme` / `themeToFlat`
 *    so existing snapshots reprint bit-identical.
 *
 * Mirrored at `supabase/functions/_shared/receipt/theme.ts` — keep the two
 * files in lockstep.
 */

import type { LayoutId } from "@/lib/receipt/layouts";

export type ThemePaperSize = "40mm" | "58mm" | "80mm" | "A4" | "A5" | "Letter";
export type ThemeFont = "A" | "B";
export type ThemeAlign = "left" | "center" | "right";
export type DensityPreset = "compact" | "standard" | "spacious";
export type LineSpacingPreset = "tight" | "normal" | "loose";
export type LogoSize = "small" | "medium" | "large";
export type CashierLabel = "Cashier" | "Served by";
export type CurrencyDisplayMode = "symbol" | "code" | "none";
export type CurrencyPosition = "before" | "after";
export type ThousandsSeparator = "," | "." | " " | "";
export type DateFormat = "iso" | "dmy" | "mdy" | "long";
export type TimeFormat = "12h" | "24h" | "none";
export type CutMode = "full" | "partial" | "none";

export type ThemeSection =
  | "header"
  | "meta"
  | "items"
  | "totals"
  | "payment"
  | "compliance"
  | "footer";

export interface ReceiptTheme {
  /** Bumped when we make a non-lossless change to this shape. */
  schemaVersion: 1;

  paper: {
    size: ThemePaperSize;
    /** Override the font-derived column count (e.g. for non-standard printers). */
    columnsOverride?: number;
    /** Spaces reserved on each side. Falls back to paper-aware default in PrinterProfile. */
    marginCols?: number;
  };

  density: {
    preset: DensityPreset;
    /** Optional override of the preset's line-spacing. */
    lineSpacing?: LineSpacingPreset;
    /** Insert a blank line between sections. */
    blankLineBetweenSections?: boolean;
  };

  typography: {
    font: ThemeFont;
    /** Bold the totals block. */
    emphasizeTotals: boolean;
    /** Render the title (RECEIPT / TAX INVOICE / …) in double-height. */
    doubleHeightTitle: boolean;
  };

  branding: {
    showLogo: boolean;
    logoSize: LogoSize;
    logoUrl?: string;
    /** Hex color for HTML/A4 paths only (thermal is monochrome). */
    primaryColor?: string;
  };

  header: {
    align: ThemeAlign;
    show: {
      storeName: boolean;
      address: boolean;
      phone: boolean;
      email: boolean;
      taxId: boolean;
    };
    customText?: string;
  };

  meta: {
    align: ThemeAlign;
    show: {
      receiptNumber: boolean;
      dateTime: boolean;
      cashier: boolean;
      register: boolean;
      customer: boolean;
    };
    cashierLabel: CashierLabel;
  };

  items: {
    layoutId: LayoutId;
    show: {
      sku: boolean;
      qty: boolean;
      unitPrice: boolean;
      discount: boolean;
      modifiers: boolean;
      taxRate: boolean;
      taxBreakdown: boolean;
    };
    truncate: {
      enabled: boolean;
      maxNameLen: number;
    };
  };

  totals: {
    align: ThemeAlign;
    show: {
      subtotal: boolean;
      discount: boolean;
      tax: boolean;
      savings: boolean;
    };
    emphasizeGrandTotal: boolean;
  };

  payment: {
    show: {
      method: boolean;
      tendered: boolean;
      change: boolean;
    };
  };

  footer: {
    align: ThemeAlign;
    customText?: string;
    returnPolicy?: {
      enabled: boolean;
      text: string;
    };
    showBarcode: boolean;
    showQrCode: boolean;
  };

  formatting: {
    currency: {
      display: CurrencyDisplayMode;
      position: CurrencyPosition;
      symbolOverride?: string;
      decimals: number;
      thousands: ThousandsSeparator;
    };
    date: DateFormat;
    time: TimeFormat;
  };

  compliance: {
    etims: {
      showInfo: boolean;
      showQr: boolean;
    };
    fiscal?: {
      provider?: string;
      showBlock: boolean;
    };
  };

  print: {
    autoPrint: boolean;
    copies: number;
    copyLabels?: string[];
    cutMode: CutMode;
    feedLinesAfter: number;
  };

  /**
   * The order sections render in. Defaults to the canonical order
   * `header → meta → items → totals → payment → compliance → footer`.
   * Engines that don't yet honour reordering will treat unknown ordering as
   * "use default".
   */
  sectionOrder: ThemeSection[];
}

export const DEFAULT_SECTION_ORDER: ThemeSection[] = [
  "header",
  "meta",
  "items",
  "totals",
  "payment",
  "compliance",
  "footer",
];
