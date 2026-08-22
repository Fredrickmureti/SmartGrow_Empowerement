/**
 * Phase 14 architecture test — Financial reports must visibly state their
 * scope (business + branch) on screen and in every export, and they must
 * never override the canonical company identity owned by ReportContext.
 *
 * The contract enforced here:
 *   1. ReportPageLayout owns scope rendering for every report:
 *        - imports FinanceScopeBadge, ReportBranchFilter,
 *          useFinanceScope, useReportExportContext
 *        - renders <FinanceScopeBadge /> next to the title
 *        - renders <ReportBranchFilter /> in the filters card
 *        - wraps every export config through enrichExportConfig and
 *          forwards the active branchId, so `renderReport` derives the
 *          masthead scope line server-side (one owner of scope, never
 *          concatenated into the subtitle)
 *   2. ReportsLayout mounts ReportContextProvider so enrichExportConfig
 *      resolves the active business identity (legal entity), not the
 *      tenant.
 *   3. Reports that already forward `branchId` from the shared
 *      ReportFilterContext (TrialBalance, GeneralLedger, FinancialReports)
 *      remain wired so the new branch filter actually narrows data.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("Phase 14 — financial reports scope labeling", () => {
  const layout = read("src/components/reports/ReportPageLayout.tsx");
  const reportsLayout = read("src/apps/reports/ReportsLayout.tsx");
  const reportContext = read("src/contexts/ReportContext.tsx");

  it("ReportPageLayout imports FinanceScopeBadge", () => {
    expect(layout).toMatch(
      /from\s+["']@\/components\/finance\/FinanceScopeBadge["']/,
    );
  });

  it("ReportPageLayout imports ReportBranchFilter", () => {
    expect(layout).toMatch(/from\s+["']\.\/ReportBranchFilter["']/);
  });

  it("ReportPageLayout consumes useFinanceScope", () => {
    expect(layout).toMatch(
      /from\s+["']@\/hooks\/finance\/useFinanceScope["']/,
    );
    expect(layout).toMatch(/useFinanceScope\(\)/);
  });

  it("ReportPageLayout consumes useReportExportContext", () => {
    expect(layout).toMatch(
      /from\s+["']@\/contexts\/ReportContext["']/,
    );
    expect(layout).toMatch(/useReportExportContext\(\)/);
  });

  it("ReportPageLayout renders <FinanceScopeBadge />", () => {
    expect(layout).toMatch(/<FinanceScopeBadge\s*\/>/);
  });

  it("ReportPageLayout renders <ReportBranchFilter />", () => {
    expect(layout).toMatch(/<ReportBranchFilter\s*\/>/);
  });

  it("ReportPageLayout wraps every export config through enrichExportConfig", () => {
    expect(layout).toMatch(/enrichExportConfig\(/);
  });

  it("ReportPageLayout forwards branchId and leaves scope to the masthead", () => {
    expect(layout).toMatch(/branchId:\s*scope\.branchId/);
    // Scope must NOT be spliced into the subtitle — the server masthead
    // owns the scope line, otherwise it renders twice.
    expect(layout).not.toMatch(/subtitle:[^\n]*scopeLabel/);
  });

  it("ReportPageLayout uses the wrapped export config for ReportExportButtons", () => {
    expect(layout).toMatch(
      /<ReportExportButtons\s+getExportConfig=\{wrappedGetExportConfig\}/,
    );
  });

  it("ReportsLayout mounts ReportContextProvider so business identity is available", () => {
    expect(reportsLayout).toMatch(
      /from\s+["']@\/contexts\/ReportContext["']/,
    );
    expect(reportsLayout).toMatch(/<ReportContextProvider>/);
  });

  it("ReportContext.enrichExportConfig prefers business identity over caller-supplied org name", () => {
    // Contract: ctx.companyName ?? config.companyName  → ctx wins.
    expect(reportContext).toMatch(
      /companyName:\s*ctx\.companyName\s*\?\?\s*config\.companyName/,
    );
    expect(reportContext).toMatch(
      /currency:\s*ctx\.currency\s*\?\?\s*config\.currency/,
    );
  });

  it("Trial Balance still forwards filters.branchId so the branch filter narrows data", () => {
    const tb = read("src/pages/reports/TrialBalance.tsx");
    expect(tb).toMatch(/branchId:\s*filters\.branchId/);
  });

  it("General Ledger still forwards filters.branchId so the branch filter narrows data", () => {
    const gl = read("src/pages/reports/GeneralLedger.tsx");
    expect(gl).toMatch(/branchId:\s*filters\.branchId/);
  });

  it("Financial Reports still forwards filters.branchId so the branch filter narrows data", () => {
    const fr = read("src/pages/reports/FinancialReports.tsx");
    expect(fr).toMatch(/branchId:\s*filters\.branchId/);
  });

  it("Aging Report threads filters.branchId into useAgingReport", () => {
    const ar = read("src/pages/reports/AgingReport.tsx");
    expect(ar).toMatch(/useReportFilters/);
    expect(ar).toMatch(/branchId:\s*filters\.branchId/);
    const hook = read("src/hooks/useAgingReport.ts");
    expect(hook).toMatch(/branchId\?:\s*string\s*\|\s*null/);
    expect(hook).toMatch(/effectiveBranchId/);
  });

  it("Partner Ledger filters journal_entries by filters.branchId", () => {
    const pl = read("src/pages/reports/PartnerLedger.tsx");
    expect(pl).toMatch(/filters\.branchId/);
    expect(pl).toMatch(/foreignTable:\s*["']journal_entries["']/);
  });

  it("Journal Report filters journal_entries by filters.branchId", () => {
    const jr = read("src/pages/reports/JournalReport.tsx");
    expect(jr).toMatch(/filters\.branchId/);
    expect(jr).toMatch(/branch_id\.eq\.\$\{filters\.branchId\}/);
  });

  it("Cash Flow Report threads filters.branchId into useCashFlowReport", () => {
    const cf = read("src/pages/reports/CashFlowReport.tsx");
    expect(cf).toMatch(/branchId:\s*filters\.branchId/);
    const hook = read("src/hooks/useCashFlowReport.ts");
    expect(hook).toMatch(/branchId\?:\s*string\s*\|\s*null/);
    expect(hook).toMatch(/_branch_id:\s*params\.branchId/);
  });

  // Wave-2 — remaining reports must also honour the branch filter
  it("Audit Trail filters journal_entries by filters.branchId", () => {
    const at = read("src/pages/reports/AuditTrail.tsx");
    expect(at).toMatch(/useReportFilters/);
    expect(at).toMatch(/filters\.branchId/);
    expect(at).toMatch(/\.eq\(["']branch_id["'],\s*branchId\)/);
  });

  it("Depreciation Report filters fixed_assets by branch", () => {
    const dr = read("src/pages/reports/DepreciationReport.tsx");
    expect(dr).toMatch(/useReportFilters/);
    expect(dr).toMatch(/branch_id\.eq\.\$\{branchId\}/);
  });

  it("Budget vs Actual reads the authoritative RPC and never aggregates the ledger in React", () => {
    const hook = read("src/hooks/useBudgetVsActual.ts");
    // Scope (business + branch), ledger visibility, closing/opening and sample
    // exclusion all live inside get_budget_variance_report.
    expect(hook).toMatch(/get_budget_variance_report/);
    expect(hook).not.toMatch(/journal_entry_lines/);
    expect(hook).not.toMatch(/budget_actuals/);
  });
});

