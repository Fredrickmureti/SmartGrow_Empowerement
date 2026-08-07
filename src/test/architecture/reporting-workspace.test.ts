/**
 * Reporting workspace guards.
 *
 * These lock the invariants the reporting workspace depends on. They are
 * deliberately structural: a report page that quietly reverts to component
 * state or a bare empty string looks fine in review and only fails in front of
 * a user (lost filters after a drill-down, an empty grid that reads as "no
 * data" when the report actually failed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPORT_REGISTRY,
  REPORT_DOMAIN_LABELS,
  getReportDomain,
  getReportsByDomain,
  getRelatedReports,
  findReportByPath,
} from "@/services/reports/ReportRegistry";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("report registry — workspace spine", () => {
  it("has unique ids and unique paths", () => {
    const ids = REPORT_REGISTRY.map((r) => r.id);
    const paths = REPORT_REGISTRY.map((r) => r.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("resolves every report to a labelled domain", () => {
    for (const def of REPORT_REGISTRY) {
      const domain = getReportDomain(def);
      expect(
        REPORT_DOMAIN_LABELS[domain],
        `unlabelled domain "${domain}" for ${def.id}`,
      ).toBeTruthy();
      expect(getReportsByDomain(domain).map((r) => r.id)).toContain(def.id);
    }
  });

  it("only declares related reports that exist, and never itself", () => {
    const ids = new Set(REPORT_REGISTRY.map((r) => r.id));
    for (const def of REPORT_REGISTRY) {
      for (const related of def.relatedReports ?? []) {
        expect(ids.has(related), `${def.id} → unknown related "${related}"`).toBe(true);
        expect(related).not.toBe(def.id);
      }
      expect(getRelatedReports(def).map((r) => r.id)).not.toContain(def.id);
    }
  });

  it("finds a report from its route path", () => {
    const auditTrail = findReportByPath("/finance/reports/audit-trail");
    expect(auditTrail?.id).toBe("audit-trail");
    expect(findReportByPath("/finance/reports/run-history")?.id).toBe(
      "report-run-history",
    );
  });

  it("registers a reader for the report run log", () => {
    const runHistory = REPORT_REGISTRY.find((r) => r.id === "report-run-history");
    expect(runHistory, "report_run_log had six writers and no reader").toBeTruthy();
    expect(runHistory!.path).toBe("/finance/reports/run-history");
  });
});

describe("report page layout — switching is mounted once, centrally", () => {
  it("renders the domain switcher strip from the shared layout", () => {
    const src = read("src/components/reports/ReportPageLayout.tsx");
    expect(src).toContain("ReportSwitcherStrip");
  });

  it("no report page hand-rolls its own switcher", () => {
    const offenders: string[] = [];
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      "grep -rl 'ReportSwitcherStrip' src/pages || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    offenders.push(...hits);
    expect(offenders).toEqual([]);
  });
});

describe("typed empty states", () => {
  const PAGES = [
    "src/pages/reports/AgingReport.tsx",
    "src/pages/reports/AuditTrail.tsx",
    "src/pages/reports/BudgetReport.tsx",
    "src/pages/reports/CashFlowReport.tsx",
    "src/pages/reports/DepreciationReport.tsx",
    "src/pages/reports/BankReconciliationReport.tsx",
    "src/pages/reports/ReportRunHistory.tsx",
    "src/pages/finance/AccountRegister.tsx",
  ];

  it("declares a typed emptyState, never a bare layout message", () => {
    for (const page of PAGES) {
      const src = read(page);
      expect(src, `${page} lost its typed emptyState`).toMatch(/emptyState=\{\{/);
      // A bare `emptyMessage` directly on ReportPageLayout is the regression we
      // are guarding; ReportTable's own emptyMessage stays legitimate.
      const layoutProps = src.slice(
        src.indexOf("<ReportPageLayout"),
        src.indexOf("emptyState={{"),
      );
      expect(layoutProps, `${page} still passes emptyMessage to the layout`).not.toMatch(
        /emptyMessage=/,
      );
    }
  });
});

describe("report library retains its state in the URL", () => {
  it("drives tab, search and domain filter from search params", () => {
    const src = read("src/pages/finance/ReportCenter.tsx");
    expect(src).toContain("useSearchParams");
    expect(src).toMatch(/params\.get\("tab"\)/);
    expect(src).toMatch(/params\.get\("q"\)/);
    expect(src).toMatch(/params\.get\("domain"\)/);
    // Library state must not live in component state, or Back loses it.
    expect(src).not.toMatch(/useState\(["']all["']\)/);
  });
});
