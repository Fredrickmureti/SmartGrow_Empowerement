/**
 * Lock the render-report payload contract for every project_* key.
 *
 * Regression target: the previous helper assembled the server-build hints
 * via a soft `as unknown as Partial<ExportConfig>` cast, so a missing
 * `dateFrom` would silently downgrade the dialog to a blank prebuilt PDF
 * instead of failing loudly. We assert the typed builder always emits a
 * server-build payload with the required fields populated.
 */
import { describe, it, expect } from "vitest";
import {
  buildProjectReportConfig,
  type ProjectReportKey,
} from "@/components/projects/projectReportConfig";

const KEYS: ProjectReportKey[] = [
  "project_portfolio",
  "project_profitability",
  "project_workload",
  "project_timesheet_detail",
  "project_status",
  "project_full_export",
];

describe("buildProjectReportConfig", () => {
  for (const key of KEYS) {
    it(`emits a server-build payload for ${key} (project-scoped)`, () => {
      const cfg = buildProjectReportConfig({
        reportType: key,
        projectId: "proj-1",
        organizationId: "org-1",
        businessId: "biz-1",
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
        title: "test",
      });
      expect(cfg.reportType).toBe(key);
      expect(cfg.dateFrom).toBe("2026-01-01");
      expect(cfg.dateTo).toBe("2026-12-31");
      expect(cfg.organizationId).toBe("org-1");
      expect(cfg.businessId).toBe("biz-1");
      expect(cfg.filters).toEqual({ projectId: "proj-1" });
      // ReportPreviewDialog uses prebuilt-mode if rows/columns are populated;
      // empty arrays force the server-build branch.
      expect(cfg.rows).toEqual([]);
      expect(cfg.columns).toEqual([]);
    });

    it(`emits an unscoped payload for ${key} when projectId is "*"`, () => {
      const cfg = buildProjectReportConfig({
        reportType: key,
        projectId: "*",
        organizationId: "org-1",
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
        title: "test",
      });
      expect(cfg.filters).toEqual({});
    });
  }

  it("treats undefined projectId as portfolio-wide", () => {
    const cfg = buildProjectReportConfig({
      reportType: "project_portfolio",
      organizationId: "org-1",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      title: "test",
    });
    expect(cfg.filters).toEqual({});
  });
});
