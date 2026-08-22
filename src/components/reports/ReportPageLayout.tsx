/**
 * Report Page Layout Component
 *
 * Standard wrapper for all report pages providing:
 * - Consistent page header with title, description, and export buttons
 * - A scope badge + branch filter so every report visibly states which
 *   business and branch it represents (Phase 14 of the Finance audit)
 * - Filter bar area
 * - Loading/error/empty states
 * - Professional report table area
 *
 * Phase 14 contract:
 *   Pages MUST NOT pass `companyName` / `organizationId` themselves; this
 *   layout enriches the page-supplied `ExportConfig` with the active
 *   business identity (via `useReportExportContext`) and appends the
 *   active scope label to the PDF subtitle so every export is unambiguous
 *   about which legal entity / branch it reflects.
 */

import { ReactNode, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, AlertCircle, FileX2 } from "lucide-react";
import { ReportsLayout } from "@/apps/reports/ReportsLayout";
import { ReportExportButtons } from "./ReportExportButtons";
import { ReportBranchFilter } from "./ReportBranchFilter";
import { ReportSwitcherStrip } from "./ReportSwitcherStrip";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useReportExportContext } from "@/contexts/ReportContext";
import { useReportViewLogger } from "@/hooks/reports/useReportViewLogger";
import {
  ReportEmptyState,
  type ReportEmptyStateDescriptor,
} from "./ReportEmptyState";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import type { ReportKind } from "@/lib/reports/branchScopability";

interface ReportPageLayoutProps {
  /** Report title */
  title: string;
  /** Report description/subtitle */
  description?: string;
  /** Whether data is loading */
  isLoading?: boolean;
  /** Error to display */
  error?: Error | null;
  /** Whether there's no data */
  isEmpty?: boolean;
  /** Custom empty state message */
  emptyMessage?: string;
  /**
   * Typed empty state. When supplied it takes precedence over
   * `emptyMessage` and names *why* there is nothing to show — including
   * `missing_presentation`, which is a defect rather than an empty period.
   * Pages still using `emptyMessage` keep the plain "no data" rendering.
   */
  emptyState?: ReportEmptyStateDescriptor;
  /** Export configuration getter (called at export time) */
  getExportConfig?: () => ExportConfig;
  /** Filter bar content */
  filters?: ReactNode;
  /** Main report content */
  children: ReactNode;
  /** Additional header actions */
  headerActions?: ReactNode;
  /**
   * Registry key for branch scoping. Pages that pass this get one
   * context-aware branch control owned by the layout (entity-only reports
   * show the rationale instead of a dropdown).
   */
  reportKind?: ReportKind;
}

export function ReportPageLayout({
  title,
  description,
  isLoading = false,
  error = null,
  isEmpty = false,
  emptyMessage = "No data found for the selected criteria",
  emptyState,
  getExportConfig,
  filters,
  children,
  headerActions,
  reportKind,
}: ReportPageLayoutProps) {
  const { enrichExportConfig } = useReportExportContext();
  const scope = useFinanceScope();
  // Phase A: log every report-page open into the central `report_views`
  // table. Resolves the report id from the current pathname via the
  // REPORT_REGISTRY; module-local pages register their path there.
  useReportViewLogger();


  // Wrap the caller's export config so EVERY exported PDF/CSV/Excel:
  //   1. Carries the active business identity (legal name + logo resolved
  //      server-side from `businessId`, never the tenant's first business)
  //   2. Uses the active business currency
  //   3. Carries the active BRANCH as structured identity (`branchId`), from
  //      which the server derives the masthead scope line.
  // The scope label is deliberately NOT concatenated into the subtitle
  // any more: the subtitle is the accounting BASIS ("Accrual basis"), and
  // scope is its own masthead line owned by `renderReport`. Two owners of
  // one string is how screen and PDF drifted apart.
  const wrappedGetExportConfig = useCallback((): ExportConfig => {
    if (!getExportConfig) {
      // Should never be called when undefined; satisfy types.
      return enrichExportConfig({ title }) as ExportConfig;
    }
    const raw = getExportConfig();
    return enrichExportConfig({
      ...raw,
      // The report's own filter state is authoritative when it supplied a
      // branch; explicit null is "All branches" and must not fall through to
      // the global branch switcher.
      branchId: raw.branchId !== undefined ? raw.branchId : scope.branchId ?? null,
    }) as ExportConfig;
  }, [getExportConfig, enrichExportConfig, scope.branchId, title]);


  return (
    <ReportsLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="page-title">{title}</h1>
              <FinanceScopeBadge />
            </div>
            {description && (
              <p className="text-muted-foreground">{description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {headerActions}
            {getExportConfig && (
              <ReportExportButtons getExportConfig={wrappedGetExportConfig} />
            )}
          </div>
        </div>

        {/* Report switching — siblings in this reporting domain plus the
            semantically related reports, carrying the current scope forward.
            Self-hides when the active route has no registered siblings. */}
        <ReportSwitcherStrip />

        {/* Filters — branch filter is always available; page-supplied
            filters render below it. ReportBranchFilter self-hides for
            single-branch businesses. */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <ReportBranchFilter reportKind={reportKind} />
            {filters}
          </CardContent>
        </Card>

        {/* Content States */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-12 text-center">
              <AlertCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
              <p className="text-destructive font-medium">Error loading report</p>
              <p className="text-sm text-muted-foreground mt-1">
                {error.message || "An unexpected error occurred"}
              </p>
            </CardContent>
          </Card>
        ) : isEmpty ? (
          emptyState ? (
            <ReportEmptyState descriptor={emptyState} />
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <FileX2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{emptyMessage}</p>
              </CardContent>
            </Card>
          )
        ) : (
          children
        )}
      </div>
    </ReportsLayout>
  );
}
