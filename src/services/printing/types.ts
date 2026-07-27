/**
 * Print/printer-status type vocabulary.
 *
 * Audit Wave 10 (P0 #6 / P1 #8). Extracted from the deleted
 * `PrintService` shim so the surviving consumers — `usePrinterStatus`,
 * `ReceiptPreviewDialog`, `PrintFallbackDialog`, `PrintPreviewDialog` —
 * can share these types without re-introducing the legacy surface.
 *
 * Single source of truth for "what does the UI know about a printer
 * right now?". Status snapshots are produced by `usePrinterStatus`
 * (which reads `hardwareClient.devices.getStatuses()` and projects the
 * relevant roles onto this shape).

/**
 * What a caller is trying to put on physical media.
 *
 * Intent — not printer model, not document type — is the input to every
 * routing decision downstream: which hardware role receives the job
 * (`INTENT_TO_ROLE`), which render format is produced (PDF / ESC-POS /
 * ZPL), and which fallback applies when no device answers.
 *
 * This lives in the shared vocabulary module rather than in `PrintClient`
 * so that device resolution and status hooks can speak about intent
 * without importing the dispatch client itself.
 */
export type PrintIntent =
  | 'receipt'        // thermal receipt printer
  | 'kitchen_ticket' // thermal kitchen printer
  | 'label'          // ZPL/EPL label printer (falls back to ESC/POS)
  | 'a4_document'    // PDF on a4_printer or browser/OS
  | 'packing_slip';  // A4 with thermal fallback


/** UI-facing snapshot of "is a printer available right now?". */
export interface PrinterStatus {
  /** True iff at least one printer role (receipt/kitchen/label) is connected. */
  available: boolean;
  /** Count of connected printer roles. 0..3 (receipt, kitchen, label). */
  printerCount: number;
  /** Stable label for the primary printer, or null when none. */
  defaultPrinter: string | null;
  /** When this snapshot was produced. */
  lastChecked: Date;
  /** Convenience: receipt printer specifically is reachable. */
  networkPrinterConnected?: boolean;
  /** Receipt printer endpoint (host:port) when known. Null in browser. */
  networkPrinter?: { ip: string; port: number } | null;
}

export type PrintFallbackAction =
  | "pdf"
  | "email"
  | "preview"
  | "cancel"
  | "retry";

export interface PrintFallbackOptions {
  onFallbackNeeded?: (status: PrinterStatus) => Promise<PrintFallbackAction>;
  autoFallbackToPDF?: boolean;
  pdfFilename?: string;
}

export interface PrintResult {
  success: boolean;
  error?: string;
  path?: string;
  fallbackUsed?: "pdf" | "browser" | "none";
  printerStatus?: PrinterStatus;
}
