/**
 * Guard: the statement line-kind vocabulary is ONE declaration.
 *
 * `src/design-system/reports/statementKinds.ts` (screen) and
 * `supabase/functions/_shared/reports/statementKinds.ts` (PDF) must be
 * byte-identical. If they drift, a statement can render one hierarchy on
 * screen and a different one in the archived PDF — the exact class of bug
 * this module was introduced to end.
 *
 * It also asserts the semantic invariants of the statement builders:
 * exactly one `grandTotal` in the P&L and the Cash Flow statement, and no
 * page inventing its own typography.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("statement line kinds", () => {
  it("screen and server copies are byte-identical", () => {
    const client = read("src/design-system/reports/statementKinds.ts");
    const server = read("supabase/functions/_shared/reports/statementKinds.ts");
    expect(server).toBe(client);
  });

  it("every screen row kind maps to a canonical statement kind", async () => {
    const { EXPORT_KIND } = await import("@/design-system/reports/model");
    const { STATEMENT_LINE_KINDS } = await import(
      "@/design-system/reports/statementKinds"
    );
    for (const mapped of Object.values(EXPORT_KIND)) {
      expect(STATEMENT_LINE_KINDS).toContain(mapped);
    }
  });

  it("every canonical kind has exactly one typographic treatment", async () => {
    const { STATEMENT_LINE_KINDS, STATEMENT_LINE_TREATMENT } = await import(
      "@/design-system/reports/statementKinds"
    );
    for (const kind of STATEMENT_LINE_KINDS) {
      expect(STATEMENT_LINE_TREATMENT[kind]).toBeDefined();
    }
    expect(Object.keys(STATEMENT_LINE_TREATMENT).sort()).toEqual(
      [...STATEMENT_LINE_KINDS].sort(),
    );
  });

  it("only the final figure of the P&L is a grand total", () => {
    const src = read("src/pages/reports/FinancialReports.tsx");
    // Gross profit / operating profit / profit before tax are DERIVED
    // figures, not the statement's result.
    expect(src).toContain('id: "gross-profit", kind: "calculatedResult"');
    expect(src).toContain('id: "operating-profit", kind: "calculatedResult"');
    expect(src).toContain('id: "net-income", kind: "grandTotal"');
  });

  it("cash flow uses activity major totals and a single closing grand total", () => {
    const src = read("src/pages/reports/CashFlowReport.tsx");
    expect(src).toContain('kind: "majorTotal"');
    expect(src).toContain('kind: "calculatedResult"');
    expect((src.match(/kind: "grandTotal"/g) ?? []).length).toBe(1);
  });

  it("statement pages never style rows themselves", () => {
    for (const file of [
      "src/pages/reports/FinancialReports.tsx",
      "src/pages/reports/CashFlowReport.tsx",
    ]) {
      const src = read(file);
      expect(src).not.toMatch(/rows?\.[\w.]*className/);
      expect(src).not.toMatch(/font-(bold|semibold).*(subtotal|total)/i);
    }
  });
});
