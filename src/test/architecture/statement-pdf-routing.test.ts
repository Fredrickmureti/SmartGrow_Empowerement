/**
 * A statement is a period ledger, not a commercial line-item document.
 *
 * Regression guard: `renderAstToPdf` once routed `sales.statement` /
 * `purchases.statement` through `generateDocumentPdf`, so downloaded and
 * emailed statements came out as invoice-shaped pages — "Bill To",
 * Qty/Price/Tax columns, "Balance Due" — with an empty item table, because a
 * statement snapshot carries no `items`. Statement kinds must reach
 * `generateStatementPdf`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(process.cwd(), "supabase/functions/_shared/rendering/renderers/pdf.ts"),
  "utf8",
);

describe("statement pdf routing", () => {
  it("routes AR and AP statement kinds to the statement layout", () => {
    expect(src).toContain("generateStatementPdf");
    expect(src).toContain('"sales.statement"');
    expect(src).toContain('"purchases.statement"');
    const gate = src.indexOf("STATEMENT_KIND_CODES.has");
    const invoiceRenderer = src.indexOf("await generateDocumentPdf(");
    expect(gate).toBeGreaterThan(-1);
    // The statement gate must short-circuit BEFORE the line-item renderer.
    expect(gate).toBeLessThan(invoiceRenderer);
  });

  it("does not treat statutory financial statements as account statements", () => {
    // `finance.statements` is P&L / balance sheet — a different layout family.
    expect(src).not.toContain('"finance.statements"');
  });
});

describe("statement download disposition", () => {
  const page = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("Download PDF downloads bytes instead of dispatching a print job", () => {
    for (const p of ["src/pages/CustomerStatements.tsx", "src/pages/VendorStatements.tsx"]) {
      const body = page(p);
      expect(body).toContain('format: "pdf"');
      expect(body).not.toContain("acknowledgeRecordPrint");
      expect(body).not.toContain("dispatchVendorStatement");
    }
  });

  it("the export seam can produce a pdf medium", () => {
    const body = page("src/services/exports/documentExport.ts");
    expect(body).toMatch(/ExportFormat\s*=\s*"csv"\s*\|\s*"xlsx"\s*\|\s*"pdf"/);
    expect(body).toContain('pdf: "application/pdf"');
  });
});
