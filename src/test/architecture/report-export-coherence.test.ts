/**
 * An export states the SAME proof as the screen it came from.
 *
 * `render-report` has two modes. SERVER-BUILD rebuilds the report from the
 * canonical engine; PREBUILT re-ships the browser's rows. A financial
 * statement page that omits `organizationId` / `dateFrom` / `dateTo` from its
 * export config silently falls into PREBUILT — the archived PDF then carries
 * the page's slice (and its truncation) instead of the engine's result.
 *
 * Two defects this guard exists to prevent:
 *  1. Cash Flow declared `reportType: "cash_flow"` but no period or org, so
 *     every export bypassed `finance_cash_flow_statement`.
 *  2. Bank Reconciliation had no server build path at all, and the export
 *     path dropped `branchId`, so a branch-scoped title could sit above
 *     whole-business figures.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const RENDER_REPORT = read("supabase/functions/render-report/index.ts");
const ENGINE = read("supabase/functions/_shared/reportDataEngine.ts");
const COLUMN_SPECS = read("supabase/functions/_shared/reports/columnSpecs.ts");
const CASH_FLOW_PAGE = read("src/pages/reports/CashFlowReport.tsx");
const BANK_REC_PAGE = read("src/pages/reports/BankReconciliationReport.tsx");

/** Body of an exported builder, from its declaration to the next export. */
function builder(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} is missing`).toBeGreaterThan(-1);
  const next = source.indexOf("export async function", start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

function exportConfig(page: string): string {
  const start = page.indexOf("getExportConfig = useCallback");
  expect(start, "page declares no export config").toBeGreaterThan(-1);
  return page.slice(start, start + 2500);
}

describe("cash flow export is server-built", () => {
  const config = exportConfig(CASH_FLOW_PAGE);

  it("carries every field render-report's server-build mode requires", () => {
    for (const field of ["reportType", "organizationId", "dateFrom", "dateTo"]) {
      expect(config, `export config is missing ${field}`).toContain(`${field}`);
    }
    expect(config).toContain('reportType: "cash_flow"');
  });

  it("states the branch it was scoped to", () => {
    expect(config).toContain("branchId");
  });
});

describe("branch is carried through the server build", () => {
  it("passes branchId into the cash flow builder", () => {
    expect(RENDER_REPORT).toMatch(
      /buildCashFlow\(\s*supabase,\s*orgId,\s*businessId,\s*dateFrom,\s*dateTo,\s*branchId/,
    );
  });

  it("hands branch and filters to buildReportData at the call site", () => {
    const call = RENDER_REPORT.slice(RENDER_REPORT.lastIndexOf("await buildReportData("));
    expect(call).toContain("branchId");
    expect(call).toContain("filters");
  });
});

describe("bank reconciliation export is the engine's proof", () => {
  const body = builder(ENGINE, "buildBankReconciliation");

  it("reads the one reconciliation engine", () => {
    expect(body).toContain("finance_bank_reconciliation_statement");
  });

  it("does no accounting arithmetic of its own", () => {
    // Rendering may negate a group for presentation; it must never decide
    // what is outstanding, nor net the two sides into a difference.
    expect(body).not.toMatch(/from\(["']bank_transactions["']\)/);
    expect(body).not.toMatch(/from\(["']journal_entry_lines["']\)/);
    expect(body).not.toMatch(/adjusted_bank[\s\S]{0,40}-[\s\S]{0,40}adjusted_book/);
  });

  it("treats an unstateable book side as an absence, not a zero", () => {
    expect(body).toContain("bookStated");
    expect(body).toContain("Not stateable");
  });

  it("refuses to build without a bank account", () => {
    expect(body).toContain("requires filters.bankAccountId");
  });

  it("is reachable through render-report under its registry key", () => {
    expect(RENDER_REPORT).toContain('case "bank_reconciliation":');
    expect(RENDER_REPORT).toContain('| "bank_reconciliation"');
    expect(COLUMN_SPECS).toContain("bank_reconciliation: {");
  });

  it("is declared by the page with the account it proves", () => {
    const config = exportConfig(BANK_REC_PAGE);
    expect(config).toContain('reportType: "bank_reconciliation"');
    expect(config).toContain("bankAccountId: statementAccountId");
    expect(config).toContain("organizationId");
  });
});
