/**
 * Architecture guard — print policy coercion (ADR-0008, Phase 4).
 *
 * Phase 4 reconciles the printer-profile authority: `paper_format` and
 * `render_mode` are orthogonal. Thermal + PDF is a legitimate combination
 * for every document type routed through `generate-document` (the PDF
 * builder emits a receipt-width PDF via `density: "narrow"`). Only two
 * combinations remain illegal:
 *   (a) `pos_receipt` on thermal paper with auto-print (no explicit
 *       `format`) — must stream as ESC/POS bytes to the physical printer.
 *   (b) `escpos` render_mode requested on printable paper — ESC/POS is
 *       only defined for thermal widths, so paper is switched to 80mm.
 * Statutory documents (payslips, tax certificates, regulator returns)
 * live in their own edge functions and are pinned to A4 there, so this
 * resolver does NOT need an allow-list.
 */
import { describe, it, expect } from "vitest";
import {
  coercePaperRenderMode,
  THERMAL_PAPER,
  PRINTABLE_PAPER,
  type PaperFormat,
} from "../../../supabase/functions/_shared/printing/coercePolicy.ts";

const NON_POS_DOC_TYPES = [
  "invoice",
  "estimate",
  "proforma",
  "credit_note",
  "purchase_order",
  "receipt",
  "sales_order",
  "delivery_note",
  "sales_return",
  "customer_statement",
  "vendor_statement",
  "bill",
] as const;

describe("coercePaperRenderMode (Phase 4)", () => {
  it("allows thermal-width PDF for non-POS docs (narrow-width archive/preview)", () => {
    for (const docType of NON_POS_DOC_TYPES) {
      for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
        const out = coercePaperRenderMode(docType, paper, "pdf");
        expect(out.render_mode).toBe("pdf");
        expect(out.paper_format).toBe(paper);
        expect(out.coerced).toBe(false);
      }
    }
  });

  it("auto-print pos_receipt on thermal paper streams ESC/POS", () => {
    for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
      const out = coercePaperRenderMode("pos_receipt", paper, "pdf");
      expect(out.render_mode).toBe("escpos");
      expect(out.paper_format).toBe(paper);
      expect(out.coerced).toBe(true);
    }
  });

  it("explicit PDF for pos_receipt on thermal renders as receipt-width PDF", () => {
    for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
      const out = coercePaperRenderMode("pos_receipt", paper, "pdf", "pdf");
      expect(out.render_mode).toBe("pdf");
      expect(out.paper_format).toBe(paper);
      expect(out.coerced).toBe(false);
    }
  });

  it("ESC/POS explicitly requested on printable paper defaults to 80mm thermal", () => {
    for (const docType of [...NON_POS_DOC_TYPES, "pos_receipt"]) {
      for (const paper of PRINTABLE_PAPER as Set<PaperFormat>) {
        const out = coercePaperRenderMode(docType, paper, "escpos", "escpos");
        expect(out.render_mode).toBe("escpos");
        expect(THERMAL_PAPER.has(out.paper_format)).toBe(true);
        expect(out.coerced).toBe(true);
      }
    }
  });

  it("leaves valid combinations untouched (PDF + printable, ESC/POS + thermal)", () => {
    for (const docType of [...NON_POS_DOC_TYPES, "pos_receipt"]) {
      for (const paper of PRINTABLE_PAPER as Set<PaperFormat>) {
        const out = coercePaperRenderMode(docType, paper, "pdf");
        expect(out.coerced).toBe(false);
        expect(out.render_mode).toBe("pdf");
        expect(out.paper_format).toBe(paper);
      }
      for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
        const out = coercePaperRenderMode(docType, paper, "escpos");
        expect(out.coerced).toBe(false);
        expect(out.render_mode).toBe("escpos");
        expect(out.paper_format).toBe(paper);
      }
    }
  });

  it("supplies a human-readable reason whenever it coerces", () => {
    const out = coercePaperRenderMode("pos_receipt", "80mm", "pdf");
    expect(out.coerced).toBe(true);
    expect(out.reason).toBeTruthy();
    expect(out.reason!.length).toBeGreaterThan(10);
  });
});
