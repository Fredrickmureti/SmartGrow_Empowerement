/**
 * Architecture guard — print policy coercion (ADR-0008, Fix 1).
 *
 * Asserts that `coercePaperRenderMode` enforces the legal
 * (documentType, paper_format, render_mode) triples so a future policy
 * edit can never re-introduce "A4 invoice template squeezed onto 80 mm
 * thermal paper" or "POS receipt rendered as a thermal-width PDF".
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

describe("coercePaperRenderMode", () => {
  it("never emits a thermal-paper PDF for non-POS documents", () => {
    for (const docType of NON_POS_DOC_TYPES) {
      for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
        const out = coercePaperRenderMode(docType, paper, "pdf");
        expect(out.render_mode).toBe("escpos");
        expect(out.coerced).toBe(true);
      }
    }
  });

  it("never emits a thermal-paper PDF for pos_receipt", () => {
    for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
      const out = coercePaperRenderMode("pos_receipt", paper, "pdf");
      expect(out.render_mode).toBe("escpos");
      expect(out.coerced).toBe(true);
    }
  });

  it("never emits ESC/POS on printable paper — coerces paper to 80mm", () => {
    for (const docType of [...NON_POS_DOC_TYPES, "pos_receipt"]) {
      for (const paper of PRINTABLE_PAPER as Set<PaperFormat>) {
        const out = coercePaperRenderMode(docType, paper, "escpos");
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
    const out = coercePaperRenderMode("invoice", "80mm", "pdf");
    expect(out.coerced).toBe(true);
    expect(out.reason).toBeTruthy();
    expect(out.reason!.length).toBeGreaterThan(10);
  });

  // Save PDF / Email PDF flows: the caller explicitly requests `pdf` even
  // when the resolved policy paper is thermal. Coercing this to ESC/POS
  // produces a .pdf file containing raw thermal bytes ("Failed to load
  // PDF document"), so the rule must switch paper to A4 instead.
  it("explicit PDF request for pos_receipt on thermal paper switches to A4 PDF", () => {
    for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
      const out = coercePaperRenderMode("pos_receipt", paper, "pdf", "pdf");
      expect(out.render_mode).toBe("pdf");
      expect(out.paper_format).toBe("a4");
      expect(out.coerced).toBe(true);
      expect(out.reason).toMatch(/explicit pdf/i);
    }
  });

  it("non-explicit PDF request for pos_receipt on thermal paper still becomes ESC/POS", () => {
    for (const paper of THERMAL_PAPER as Set<PaperFormat>) {
      const out = coercePaperRenderMode("pos_receipt", paper, "pdf");
      expect(out.render_mode).toBe("escpos");
      expect(out.paper_format).toBe(paper);
    }
  });

  it("explicit PDF request for non-POS docs on thermal paper switches to A4 PDF", () => {
    const out = coercePaperRenderMode("invoice", "80mm", "pdf", "pdf");
    expect(out.render_mode).toBe("pdf");
    expect(out.paper_format).toBe("a4");
    expect(out.coerced).toBe(true);
  });
});