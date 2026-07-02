/**
 * Receipt document types — moved out of the deleted PrinterService shell.
 *
 * These shapes describe a printable receipt at the consumer surface
 * (POS components, useHardwareProxy). They are intentionally
 * driver-agnostic — actual ESC/POS byte building lives in
 * `src/lib/pos/receipt/` and in main-process drivers.
 */

import type { PaperSize } from "@/types/receipt";

export interface ReceiptLine {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  doubleWidth?: boolean;
  doubleHeight?: boolean;
}

export interface ReceiptImage {
  src: string;
  width?: number;
  align?: "left" | "center" | "right";
}

export interface ReceiptData {
  header?: ReceiptLine[];
  logo?: ReceiptImage;
  lines: ReceiptLine[];
  barcode?: {
    data: string;
    type?: "EAN13" | "CODE128" | "QR";
  };
  footer?: ReceiptLine[];
  cut?: boolean;
  openDrawer?: boolean;
  paperSize?: PaperSize;
}