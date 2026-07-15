/**
 * PayrollReportViewer — one URL, one report.
 *
 * Route: /hr/payroll/reports/:reportKey
 *
 * Resolves the definition from `payroll_report_definitions`, renders the
 * declared parameters, dispatches to the preview appropriate for the
 * definition's `preview_kind`, and surfaces the definition's declared
 * `export_formats`. Every successful generation writes a
 * `payroll_report_runs` history record.
 *
 * The viewer never hardcodes report keys or export formats. Adding a
 * new report — including one published by a localization pack — needs no
 * change to this file: it only requires a `payroll_report_definitions`
 * row and (for non-`table` previews) a preview component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilters } from "@/components/reports/ReportFilters";
import {
  ReportFilterProvider,
  useReportFilters,
} from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

import {
  usePayrollReportDefinitions,
  OWNER_LABEL,
  type PayrollReportDefinition,
} from "@/hooks/payroll/usePayrollReportDefinitions";
import { useRecordPayrollReportRun } from "@/hooks/payroll/usePayrollReportRuns";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";

import { PayrollReportPreview } from "./previews/PayrollReportPreview";
import { PackArtifactPanel } from "./previews/PackArtifactPanel";
import { PayrollReportMetadataBand } from "./PayrollReportMetadataBand";
import { PayrollReportReadinessChips } from "./PayrollReportReadinessChips";
import { usePayrollReportReadiness } from "@/hooks/payroll/usePayrollReportReadiness";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

function ViewerInner() {
  const { reportKey } = useParams<{ reportKey: string }>();
  const navigate = useNavigate();
  const now = new Date();
  const { filters } = useReportFilters();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const canSeeMoney = can("viewSalaryDetails");
  const record = useRecordPayrollReportRun();

  const [dateFrom, setDateFrom] = useState(
    filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"),
  );
  const [dateTo, setDateTo] = useState(
    filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"),
  );

  const { data: defs, isLoading: defsLoading } = usePayrollReportDefinitions(
    currentOrg?.id ?? null,
    currentBusiness?.id ?? null,
  );
  const definition: PayrollReportDefinition | undefined = useMemo(
    () => defs?.find((d) => d.reportKey === reportKey),
    [defs, reportKey],
  );

  const isPackArtifact =
    !!definition?.dataSource && definition.dataSource.startsWith("pack_artifact.");

  // Lifecycle-aware default period: for reports gated on `payroll_approved`,
  // snap the initial period to the latest approved payroll run instead of
  // the current calendar month. This is the single largest cause of
  // "empty report" complaints mid-month. Runs once per (org, business,
  // reportKey) and only if the user hasn't already picked a period via
  // the shared ReportFilterContext.
  const defaultedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!definition || !currentOrg?.id) return;
    if (filters.dateFrom || filters.dateTo) return;
    if (!(definition.dependencies ?? []).includes("payroll_approved")) return;
    const cacheKey = `${currentOrg.id}:${currentBusiness?.id ?? ""}:${definition.reportKey}`;
    if (defaultedRef.current === cacheKey) return;
    defaultedRef.current = cacheKey;
    (async () => {
      // Canonical columns on `payroll_runs` are `pay_period_start` /
      // `pay_period_end`. Selecting the non-existent `period_start` /
      // `period_end` silently made this effect a no-op, leaving reports
      // stuck on the current calendar month and appearing empty whenever
      // the tenant had no approved run in that window.
      let q = (supabase as any)
        .from("payroll_runs")
        .select("pay_period_start, pay_period_end")
        .eq("organization_id", currentOrg.id)
        .not("approved_at", "is", null)
        .order("approved_at", { ascending: false })
        .limit(1);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data: r } = await q;
      const row = Array.isArray(r) && r[0] ? r[0] : null;
      if (row?.pay_period_start && row?.pay_period_end) {
        setDateFrom(row.pay_period_start);
        setDateTo(row.pay_period_end);
      }
    })().catch(() => undefined);
  }, [definition, currentOrg?.id, currentBusiness?.id, filters.dateFrom, filters.dateTo]);

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: [
      "payroll-report",
      reportKey,
      currentOrg?.id,
      currentBusiness?.id,
      filters.branchId,
      dateFrom,
      dateTo,
    ],
    // Pack-owned artifacts (statutory returns, tax certificates) are
    // generated by their canonical workflows — not by `render-report`.
    // The viewer becomes a catalog surface for them via PackArtifactPanel.
    enabled: !!currentOrg?.id && !!definition && !isPackArtifact,
    queryFn: async () => {
      const started = Date.now();
      const { data, error } = await supabase.functions.invoke("render-report", {
        body: {
          reportType: reportKey,
          organizationId: currentOrg!.id,
          businessId: currentBusiness?.id,
          dateFrom,
          dateTo,
          format: "json",
          filters: { branchId: filters.branchId },
        },
      });
      if (error) throw error;
      const result = data as {
        columns?: { key: string; header: string; format?: string; align?: string }[];
        data: any[];
      };
      const rowCount = result?.data?.length ?? 0;
      // Fire-and-forget history record. We do not block the UI on it.
      if (definition && currentOrg?.id) {
        void record.mutateAsync({
          organizationId: currentOrg.id,
          businessId: currentBusiness?.id ?? null,
          reportKey: reportKey!,
          reportLabel: definition.label,
          ownerKind: definition.ownerKind,
          params: { dateFrom, dateTo },
          filters: { branchId: filters.branchId ?? null },
          rowCount,
          durationMs: Date.now() - started,
          packCode: (definition.metadata as any)?.pack_code ?? null,
          packVersion: (definition.metadata as any)?.pack_version ?? null,
          templateVersion: (definition.metadata as any)?.template_version ?? null,
        }).catch(() => undefined);
      }
      return result;
    },
  });

  const { data: readiness } = usePayrollReportReadiness({
    organizationId: currentOrg?.id,
    businessId: currentBusiness?.id ?? null,
    reportKey: reportKey ?? null,
    dateFrom,
    dateTo,
    dependencies: definition?.dependencies ?? [],
    enabled: !!definition,
  });

  const rows: any[] = data?.data ?? [];
  const columns = data?.columns ?? [];

  const isMoneyCol = (col: { format?: string; key: string }) =>
    col.format === "currency" || /amount|total|gross|net|pay|cost/i.test(col.key);

  const getExportConfig = useCallback((): ExportConfig => {
    const exportRows: ExportRow[] = rows.map((r) => {
      const out: any = {};
      for (const c of columns) {
        out[c.key] = isMoneyCol(c) && !canSeeMoney ? null : r[c.key];
      }
      return out;
    });
    return {
      title: definition?.label ?? String(reportKey),
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(
        new Date(dateTo),
        "MMM d, yyyy",
      )}`,
      columns: columns.map((c) => ({
        key: c.key,
        header: c.header,
        format: (c.format as any) ?? undefined,
        align: (c.align as any) ?? undefined,
      })),
      rows: exportRows,
      sheetName: definition?.label ?? String(reportKey),
    };
  }, [rows, columns, reportKey, definition, dateFrom, dateTo, currentOrg, canSeeMoney]);

  if (defsLoading) {
    return (
      <ReportPageLayout title="Loading report…" isLoading>
        {null}
      </ReportPageLayout>
    );
  }

  if (!definition) {
    return (
      <ReportPageLayout
        title="Report not found"
        description={`No active report definition for "${reportKey}".`}
        headerActions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/hr/payroll/reports">
              <ChevronLeft className="mr-1 h-4 w-4" />
              Back to Reporting Centre
            </Link>
          </Button>
        }
      >
        <Card>
          <CardContent className="py-12 text-sm text-muted-foreground text-center">
            The registry has no active row for this key. If it belongs to a
            localization pack, install the pack from Localization → Packs.
          </CardContent>
        </Card>
      </ReportPageLayout>
    );
  }

  return (
    <ReportPageLayout
      title={definition.label}
      description={definition.description ?? undefined}
      isLoading={isPackArtifact ? false : isLoading}
      error={isPackArtifact ? null : (error as Error | null)}
      isEmpty={isPackArtifact ? false : !isLoading && rows.length === 0}
      getExportConfig={isPackArtifact ? undefined : getExportConfig}
      headerActions={
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
            {OWNER_LABEL[definition.ownerKind]}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => navigate("/hr/payroll/reports")}>
            <ChevronLeft className="mr-1 h-4 w-4" />
            All reports
          </Button>
        </div>
      }
      filters={
        <ReportFilters
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        >
          <ReportBranchFilter reportKind="journal" />
        </ReportFilters>
      }
    >
      <PayrollReportMetadataBand
        definition={definition}
        dateFrom={dateFrom}
        dateTo={dateTo}
        rowCount={rows.length}
        generatedAt={dataUpdatedAt ? new Date(dataUpdatedAt) : null}
      />
      <PayrollReportReadinessChips
        dependencies={definition.dependencies ?? []}
        readiness={readiness}
      />
      {isPackArtifact ? (
        <PackArtifactPanel
          definition={definition}
          dateFrom={dateFrom}
          dateTo={dateTo}
        />
      ) : (
        <PayrollReportPreview
          definition={definition}
          columns={columns}
          rows={rows}
          canSeeMoney={canSeeMoney}
        />
      )}
    </ReportPageLayout>
  );
}

export function PayrollReportViewer() {
  return (
    <ReportFilterProvider>
      <ViewerInner />
    </ReportFilterProvider>
  );
}

export default PayrollReportViewer;
