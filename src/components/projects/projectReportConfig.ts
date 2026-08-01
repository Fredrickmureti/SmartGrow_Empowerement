/**
 * projectReportConfig — single source of truth for the payload shape that
 * `ProjectReportsMenu` and `RunProjectReportButton` send to `render-report`
 * via `ReportPreviewDialog`.
 *
 * Why: the dialog picks SERVER-BUILD vs PREBUILT mode purely from whether
 * `reportType + dateFrom + dateTo` are present on the config. A missing
 * field silently downgrades to a blank-PDF prebuilt render. This helper
 * makes the contract explicit and unit-testable.
 */
import type { ExportConfig } from "@/services/reports/ReportExportService";

export type ProjectReportKey =
  | "project_portfolio"
  | "project_profitability"
  | "project_workload"
  | "project_timesheet_detail"
  | "project_status"
  | "project_full_export";

export interface ServerBuildHints {
  reportType: ProjectReportKey;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;   // YYYY-MM-DD
  organizationId: string | undefined;
  businessId?: string;
  filters: Record<string, unknown>;
}

export interface BuildProjectReportConfigInput {
  reportType: ProjectReportKey;
  /** "*" or undefined => portfolio-wide; otherwise scoped to the given project. */
  projectId?: string;
  organizationId: string | undefined;
  businessId?: string;
  dateFrom: string;
  dateTo: string;
  title: string;
  subtitle?: string;
  currency?: string;
}

/**
 * Build the ExportConfig ReportPreviewDialog forwards to render-report.
 * The server-build hints are attached as extra fields the dialog reads
 * via a typed cast — keep them in sync with ReportPreviewDialog.
 */
export function buildProjectReportConfig(
  input: BuildProjectReportConfigInput,
): ExportConfig & ServerBuildHints {
  const projectFilter =
    input.projectId && input.projectId !== "*"
      ? { projectId: input.projectId }
      : {};
  return {
    title: input.title,
    subtitle: input.subtitle,
    dateRange: `${input.dateFrom} to ${input.dateTo}`,
    columns: [],
    rows: [],
    currency: input.currency,
    // Server-build hints (consumed by ReportPreviewDialog):
    reportType: input.reportType,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    organizationId: input.organizationId,
    businessId: input.businessId,
    filters: projectFilter,
  };
}
