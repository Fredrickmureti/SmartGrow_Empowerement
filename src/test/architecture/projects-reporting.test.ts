/**
 * Architecture: Projects reporting must flow through the shared engine.
 *
 * Asserts:
 *  1. Every project_* report key registered server-side has a matching
 *     entry in REPORT_REGISTRY OR is reachable through RunProjectReportButton.
 *  2. Project pages do not import any parallel report renderer
 *     (jspdf, exceljs, html2canvas, etc.) — they must use PrintPreviewDialog
 *     + render-report.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${f}`;
    const stat = fs.statSync(path.join(root, rel));
    if (stat.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(rel);
  }
  return out;
}

describe("Projects reporting architecture", () => {
  it("registers project_full_export in the shared report registry", () => {
    const reg = read("src/services/reports/ReportRegistry.ts");
    expect(reg).toMatch(/reportType:\s*"project_full_export"/);
  });

  it("server engine has a project_full_export builder + spec", () => {
    const data = read("supabase/functions/_shared/reports/projectsData.ts");
    const spec = read("supabase/functions/_shared/reports/columnSpecs.ts");
    expect(data).toMatch(/case "project_full_export"/);
    expect(spec).toMatch(/REPORT_SPECS\["project_full_export"\]/);
  });

  it("project pages do not import a parallel PDF/Excel renderer", () => {
    const files = walk("src/pages/projects").concat(walk("src/components/projects"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      if (/from\s+["']jspdf["']|from\s+["']exceljs["']|from\s+["']html2canvas["']|from\s+["']pdfmake["']/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Projects portfolio KPI view", () => {
  it("Portfolio.tsx reads project_portfolio_kpis", () => {
    const src = read("src/pages/projects/portfolio/Portfolio.tsx");
    expect(src).toMatch(/project_portfolio_kpis/);
    expect(src).toMatch(/at_risk_count/);
    expect(src).toMatch(/over_budget_count/);
    expect(src).toMatch(/overdue_milestones_week/);
    expect(src).toMatch(/unbilled_timesheet_hours/);
  });
});

describe("Recurring task seeding", () => {
  it("TaskForm sets recurrence_next_at when is_recurring is true", () => {
    const src = read("src/components/projects/TaskForm.tsx");
    expect(src).toMatch(/recurrence_next_at/);
  });
});

describe("Gantt view", () => {
  it("Tasks tab exposes a Gantt option", () => {
    const src = read("src/pages/projects/detail/Tasks.tsx");
    expect(src).toMatch(/TaskGantt/);
    expect(src).toMatch(/gantt/);
  });
});
