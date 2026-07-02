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
 * `explicitFormatRequest` is the value the *caller* explicitly asked for
 * (request body `format`). When omitted, the policy's default
 * `render_mode` drives coercion (auto-print path). When set to `"pdf"`,
 * the caller is explicitly asking for a portable PDF artifact (Save PDF /
 * Email PDF), which must NEVER be coerced into ESC/POS — instead we
 * switch the paper from thermal to A4 so the PDF is actually usable.
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

  if (documentType === "pos_receipt") {
    if (mode === "pdf" && isThermal) {
      if (explicitPdf) {
        return {
          paper_format: "a4",
          render_mode: "pdf",
          coerced: true,
          reason:
            "Explicit PDF requested for pos_receipt — switching paper from thermal to A4 so the file is a real PDF, not ESC/POS bytes",
        };
      }
      return {
        paper_format: paperFormat,
        render_mode: "escpos",
        coerced: true,
        reason: "pos_receipt on thermal paper must render as ESC/POS, not PDF",
      };
    }
    if (mode === "escpos" && isPrintable) {
      return {
        paper_format: "80mm",
        render_mode: "escpos",
        coerced: true,
        reason: "ESC/POS render mode requires thermal paper; defaulting to 80mm",
      };
    }
    return { paper_format: paperFormat, render_mode: mode, coerced: false };
  }

  if (isThermal && mode === "pdf") {
    if (explicitPdf) {
      return {
        paper_format: "a4",
        render_mode: "pdf",
        coerced: true,
        reason: `Explicit PDF requested for ${documentType} — switching paper from thermal to A4`,
      };
    }
    return {
      paper_format: paperFormat,
      render_mode: "escpos",
      coerced: true,
      reason: `${documentType} on thermal paper must render as ESC/POS, not a constricted PDF`,
    };
  }
  if (mode === "escpos" && isPrintable) {
    return {
      paper_format: "80mm",
      render_mode: "escpos",
      coerced: true,
      reason: "ESC/POS render mode requires thermal paper; defaulting to 80mm",
    };
  }
  return { paper_format: paperFormat, render_mode: mode, coerced: false };
}