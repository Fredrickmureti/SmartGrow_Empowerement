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

describe("statements never acquire a printer target from a document print policy", () => {
  const migrations = () => {
    const dir = resolve(process.cwd(), "supabase/migrations");
    return require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".sql"))
      .map((f: string) => readFileSync(resolve(dir, f), "utf8"))
      .join("\n");
  };

  it("resolve_output_intent excludes statement kinds from the policy print target", () => {
    const sql = migrations();
    // The latest definition must know statements are not transactional
    // documents: no print-disposition target derived from
    // `document_print_policies`, and no thermal receipt path.
    const last = sql.lastIndexOf("CREATE OR REPLACE FUNCTION public.resolve_output_intent");
    expect(last).toBeGreaterThan(-1);
    const def = sql.slice(last);
    expect(def).toContain("v_is_statement");
    expect(def).toContain("AND NOT v_is_statement");
    const thermalList = def.slice(
      def.indexOf("v_is_thermal_capable_kind :="),
      def.indexOf("IF p_organization_id IS NOT NULL"),
    );
    expect(thermalList).not.toContain("customer_statement");
    expect(thermalList).not.toContain("vendor_statement");
  });
});

describe("customer statements have one dispatch exit", () => {
  const file = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("the AR side mirrors the AP single-exit module", () => {
    const exit = file("src/features/sales/statements/dispatchCustomerStatement.ts");
    expect(exit).toContain("downloadCustomerStatement");
    expect(exit).toContain("dispatchCustomerStatement");
    expect(exit).toContain('kindCode: "sales.statement"');
  });

  it("the statements page does not call the raw export seam", () => {
    const page = file("src/pages/CustomerStatements.tsx");
    expect(page).toContain("downloadCustomerStatement");
    expect(page).not.toContain("downloadExport(");
    expect(page).not.toContain('documentType: "customer_statement"');
  });
});

describe("statements render as a legible landscape ledger", () => {
  const file = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("generateStatementPdf uses the ledger profile on a landscape canvas", () => {
    const gen = file("supabase/functions/_shared/pdfGenerator.ts");
    const start = gen.indexOf("export async function generateStatementPdf");
    expect(start).toBeGreaterThan(-1);
    const body = gen.slice(start);
    expect(body).toContain('resolveTypography("ledger")');
    expect(body).toContain('options.orientation ?? "landscape"');
    // typography must reach every band of the page, not just the table
    expect(body).toContain("drawPageNumber(builder, page, stmtTypography)");
    expect(body).toContain("typography: stmtTypography");
    expect(body).toContain("drawSummaryBlock(builder, builder.page, summaryItems, stmtTypography)");
    expect(body).not.toContain('orientation: "portrait"');
  });

  it("the ledger profile stays above the legibility floor", () => {
    const p = file("supabase/functions/_shared/pdf/themes/presentation.ts");
    const start = p.indexOf("LEDGER_TYPOGRAPHY");
    expect(start).toBeGreaterThan(-1);
    const block = p.slice(start, start + 900);
    const cell = Number(/tableCell:\s*([\d.]+)/.exec(block)?.[1]);
    const floor = Number(/minNumericFontSize:\s*([\d.]+)/.exec(block)?.[1]);
    expect(cell).toBeGreaterThanOrEqual(8.5);
    expect(floor).toBeGreaterThanOrEqual(7.5);
  });
});
