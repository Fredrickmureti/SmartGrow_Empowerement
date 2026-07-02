/**
 * Server mirror of `src/types/receiptTheme.ts`. Keep in lockstep.
 *
 * Identical body — only the import path differs (relative for Deno).
 */

import type { LayoutId } from "./layouts/index.ts";

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
  schemaVersion: 1;
  paper: { size: ThemePaperSize; columnsOverride?: number; marginCols?: number };
  density: { preset: DensityPreset; lineSpacing?: LineSpacingPreset; blankLineBetweenSections?: boolean };
  typography: { font: ThemeFont; emphasizeTotals: boolean; doubleHeightTitle: boolean };
  branding: { showLogo: boolean; logoSize: LogoSize; logoUrl?: string; primaryColor?: string };
  header: {
    align: ThemeAlign;
    show: { storeName: boolean; address: boolean; phone: boolean; email: boolean; taxId: boolean };
    customText?: string;
  };
  meta: {
    align: ThemeAlign;
    show: { receiptNumber: boolean; dateTime: boolean; cashier: boolean; register: boolean; customer: boolean };
    cashierLabel: CashierLabel;
  };
  items: {
    layoutId: LayoutId;
    show: { sku: boolean; qty: boolean; unitPrice: boolean; discount: boolean; modifiers: boolean; taxRate: boolean; taxBreakdown: boolean };
    truncate: { enabled: boolean; maxNameLen: number };
  };
  totals: {
    align: ThemeAlign;
    show: { subtotal: boolean; discount: boolean; tax: boolean; savings: boolean };
    emphasizeGrandTotal: boolean;
  };
  payment: { show: { method: boolean; tendered: boolean; change: boolean } };
  footer: {
    align: ThemeAlign;
    customText?: string;
    returnPolicy?: { enabled: boolean; text: string };
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
    etims: { showInfo: boolean; showQr: boolean };
    fiscal?: { provider?: string; showBlock: boolean };
  };
  print: {
    autoPrint: boolean;
    copies: number;
    copyLabels?: string[];
    cutMode: CutMode;
    feedLinesAfter: number;
  };
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
