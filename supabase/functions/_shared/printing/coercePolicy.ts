/**
 * Pure (no Deno / no Supabase) policy coercion — split out of
 * resolvePolicy.ts so it can be imported by both the edge function
 * (Deno) and the Vitest architecture guard (Node) without dragging the
 * `https://esm.sh/...` Supabase client import into the Node test runner.
 */

export type PaperFormat = "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm";
export type RenderMode = "pdf" | "escpos" | "html";

// Phase 1 — 40mm thermal label/handheld printers are first-class. Coercion
// treats 40mm exactly like 58mm/80mm: thermal-only, ESC/POS-only.
export const THERMAL_PAPER: ReadonlySet<PaperFormat> = new Set(["80mm", "58mm", "40mm"]);
export const PRINTABLE_PAPER: ReadonlySet<PaperFormat> = new Set(["a4", "letter", "a5"]);

export interface CoercedPolicy {
  paper_format: PaperFormat;
  render_mode: "pdf" | "escpos";
  coerced: boolean;
  reason?: string;
}

/**
 * Enforce legal `(documentType, paper_format, render_mode)` triples.
 *
 * Phase 4 (printer-profile authority reconciliation, ADR-0008):
 *   `paper_format` and `render_mode` are ORTHOGONAL. A "Thermal 80mm + PDF"
 *   invoice is a legitimate archive/email artifact — the PDF renderer will
 *   emit a receipt-width PDF via `PdfBuilder` (density: "narrow"). Coercion
 *   is now reserved for the two genuinely illegal cases only:
 *     (a) `pos_receipt` on thermal paper + auto-print (no explicit `format`)
 *         must go to ESC/POS bytes for the physical printer.
 *     (b) `escpos` render_mode explicitly requested on printable paper
 *         (A4/Letter/A5) — ESC/POS is only defined for thermal widths.
 *   All other combinations pass through unchanged.
 *
 * `explicitFormatRequest` is the caller's request-body `format`. When set,
 * the caller has an explicit intent (Save PDF / Email PDF / stream ESC/POS)
 * and we honour paper+format together instead of falling back.
 *
 * NOTE: statutory documents (payslips, tax certificates, regulator returns)
 * are NOT routed through this resolver — they render in dedicated edge
 * functions with `assertStatutoryPaper("a4")` pins per ADR-0008. So there
 * is no allow-list needed here; every document type handled by
 * `generate-document` is free to render at any paper width.
 */
export function coercePaperRenderMode(
  documentType: string,
  paperFormat: PaperFormat,
  renderMode: RenderMode,
  explicitFormatRequest?: "pdf" | "escpos",
): CoercedPolicy {
  const isThermal = THERMAL_PAPER.has(paperFormat);
  const isPrintable = PRINTABLE_PAPER.has(paperFormat);
  const mode: "pdf" | "escpos" = renderMode === "escpos" ? "escpos" : "pdf";
  const explicitPdf = explicitFormatRequest === "pdf";
  const explicitEscpos = explicitFormatRequest === "escpos";

  // Case (a): POS receipt on thermal, no explicit PDF ask → ESC/POS bytes.
  // Explicit PDF request produces a narrow-width receipt PDF (preview /
  // email / archive) — still on thermal paper, not A4.
  if (documentType === "pos_receipt" && isThermal && mode === "pdf" && !explicitPdf) {
    return {
      paper_format: paperFormat,
      render_mode: "escpos",
      coerced: true,
      reason: "pos_receipt auto-print on thermal paper streams ESC/POS to the printer",
    };
  }

  // Case (b): ESC/POS explicitly requested on printable paper. ESC/POS is
  // only defined for thermal widths; default to 80mm.
  if (mode === "escpos" && isPrintable && (explicitEscpos || !explicitPdf)) {
    return {
      paper_format: "80mm",
      render_mode: "escpos",
      coerced: true,
      reason: "ESC/POS render mode requires thermal paper; defaulting to 80mm",
    };
  }

  // Everything else — including non-POS thermal + PDF — is legal. The PDF
  // builder renders receipt-width PDFs via density: "narrow".
  return { paper_format: paperFormat, render_mode: mode, coerced: false };
}