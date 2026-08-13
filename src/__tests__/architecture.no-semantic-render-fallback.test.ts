import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No semantic fallback in the PDF renderer.
 *
 * JE-00001 once printed as an invoice — "Bill To", Qty/Price/Tax, KES 0.00
 * — because a journal voucher whose kind had no registered layout fell
 * through to `generateDocumentPdf`, the commercial renderer. A missing
 * renderer must surface as a diagnosable configuration error, never as a
 * different document.
 */
const PDF_RENDERER = join(
  process.cwd(),
  "supabase/functions/_shared/rendering/renderers/pdf.ts",
);
const SRC = readFileSync(PDF_RENDERER, "utf8");

describe("pdf renderer dispatch", () => {
  it("registers finance.journal_entry against the journal voucher layout", () => {
    expect(SRC).toMatch(/LEDGER_LAYOUTS[\s\S]{0,400}?"finance\.journal_entry"/);
    expect(SRC).toContain("generateJournalVoucherPdf");
  });

  it("guards the commercial fallthrough before calling generateDocumentPdf", () => {
    expect(SRC).toContain("assertCommercialFallthroughAllowed");
    const guardAt = SRC.indexOf("assertCommercialFallthroughAllowed(args.template");
    const commercialAt = SRC.indexOf("await generateDocumentPdf(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(commercialAt).toBeGreaterThan(guardAt);
  });

  it("throws renderer_not_registered instead of drawing an unknown kind commercially", () => {
    expect(SRC).toContain("renderer_not_registered:");
  });
});
