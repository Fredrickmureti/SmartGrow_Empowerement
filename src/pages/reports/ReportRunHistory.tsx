/**
 * Report Run History — the reader for `report_run_log` (Phase G).
 *
 * Every rendition produced by the canonical reporting engine writes a row to
 * `report_run_log` (actor, org, business, report type, params, row/byte count,
 * status, run hash). Until now that table had six writers and no reader: the
 * audit existed but nobody could see it. This page is that reader.
 *
 * It is deliberately a *log* view, not an analytics surface:
 *  - no aggregation or scoring, because a run log answers "who produced which
 *    figures, with which parameters, and when" — inventing KPIs on top of it
 *    would make the audit trail look like a performance dashboard;
 *  - `params_jsonb` is shown verbatim in a detail dialog, because the exact
 *    parameter set is the thing an auditor needs to reproduce the run;
 *  - `run_hash` is surfaced as-is so two renditions of the same figures can be
 *    proven identical.
 *
 * RLS: `report_run_log` exposes SELECT to org members only
 * (`is_org_member(auth.uid(), organization_id)`), so this page reads the table
 * directly through the user's session — no privileged path.
 */

import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { REPORT_REGISTRY } from "@/services/reports/ReportRegistry";

interface ReportRunRow {
  id: string;
  organization_id: string | null;
  business_id: string | null;
  user_id: string | null;
  report_type: string;
  status: string;
  run_hash: string;
  byte_count: number;
  params_jsonb: Record<string, unknown> | null;
  created_at: string;
}

/** Registry names beat raw report_type keys wherever the key is registered. */
function reportLabel(reportType: string): string {
  const hit = REPORT_REGISTRY.find(
    (r) => r.reportType === reportType || r.id === reportType,
  );
  return hit?.name ?? reportType;
}

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  const s = status.toLowerCase();
  if (s === "error" || s === "failed") return "destructive";
  if (s === "ok" || s === "success" || s === "completed") return "secondary";
  return "outline";
}

function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ReportRunHistoryInner() {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(now), "yyyy-MM-dd"));
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailRow, setDetailRow] = useState<ReportRunRow | null>(null);

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "report-run-log",
      currentOrg?.id,
      currentBusiness?.id,
      dateFrom,
      dateTo,
      typeFilter,
      statusFilter,
    ],
    queryFn: async (): Promise<ReportRunRow[]> => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("report_run_log")
        .select(
          "id, organization_id, business_id, user_id, report_type, status, run_hash, byte_count, params_jsonb, created_at",
        )
        .eq("organization_id", currentOrg.id)
        .gte("created_at", `${dateFrom}T00:00:00`)
        .lte("created_at", `${dateTo}T23:59:59`)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (typeFilter !== "all") q = q.eq("report_type", typeFilter);
      if (statusFilter !== "all") q = q.eq("status", statusFilter);
      const { data: rows, error: e } = await q;
      if (e) throw e;
      return (rows || []) as unknown as ReportRunRow[];
    },
    enabled: !!currentOrg?.id,
  });

  // Filter options come from the rows actually present, not from a hardcoded
  // list: the engine can log a report type this build does not know about.
  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of data || []) s.add(r.report_type);
    return Array.from(s).sort();
  }, [data]);

  const statusOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of data || []) if (r.status) s.add(r.status);
    return Array.from(s).sort();
  }, [data]);

  const rawById = useMemo(() => {
    const m = new Map<string, ReportRunRow>();
    for (const r of data || []) m.set(r.id, r);
    return m;
  }, [data]);

  const columns = useMemo<ReportColumn<ReportRunRow>[]>(
    () => [
      { key: "when", header: "When", width: "w-[160px]" },
      { key: "report", header: "Report" },
      { key: "status", header: "Status", width: "w-[110px]" },
      { key: "size", header: "Size", width: "w-[100px]", align: "right" },
      { key: "hash", header: "Run hash", width: "w-[140px]" },
      {
        key: "detail",
        header: "",
        width: "w-[56px]",
        exportExclude: true,
        render: (row) => {
          const raw = rawById.get(String(row.id));
          if (!raw) return null;
          return (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                setDetailRow(raw);
              }}
              aria-label="View report run parameters"
            >
              <Eye className="h-4 w-4" />
            </Button>
          );
        },
      },
    ],
    [rawById],
  );

  const rows = useMemo<ReportRow[]>(
    () =>
      (data || []).map((r) => ({
        id: r.id,
        onClick: () => setDetailRow(r),
        values: {
          when: format(new Date(r.created_at), "MMM d, yyyy HH:mm"),
          report: reportLabel(r.report_type),
          status: r.status || null,
          size: formatBytes(r.byte_count),
          hash: r.run_hash ? `${r.run_hash.slice(0, 12)}…` : null,
        },
      })),
    [data],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    return {
      title: "Report Run History",
      reportType: "report_run_history",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns as ReportColumn<never>[]),
      rows: toExportRows(rows, columns as ReportColumn<never>[]),
      sheetName: "Report Runs",
    };
  }, [columns, rows, dateFrom, dateTo, currentOrg]);

  return (
    <CompanyScopeGate reportName="Report Run History">
      <ReportPageLayout
        title="Report Run History"
        description="Every report rendition produced by the reporting engine — who ran it, with which parameters, and what it produced"
        isLoading={isLoading}
        error={error as Error | null}
        isEmpty={!data || data.length === 0}
        emptyState={{
          kind: "no_data",
          title: "No report runs in this period",
          message:
            "Nobody produced a report rendition for this organization and date range. Exports and PDF renditions appear here as soon as they are generated.",
        }}
        getExportConfig={getExportConfig}
        headerActions={
          <RefreshButton
            queryKeyPrefixes={[["report-run-log"] as const]}
            tooltip="Refresh run history"
          />
        }
        filters={
          <ReportFilters
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
          >
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Report" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reports</SelectItem>
                {typeOptions.map((t) => (
                  <SelectItem key={t} value={t}>
                    {reportLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ReportFilters>
        }
      >
        <ReportSurface
          companyName={currentOrg?.name || ""}
          title="Report Run History"
          dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
          subtitle={`${data?.length || 0} renditions (capped at 1,000)`}
          profile="operational"
        >
          <ReportTable
            columns={columns as ReportColumn<never>[]}
            rows={rows}
            caption="Report renditions logged by the reporting engine"
            emptyMessage="No report runs found for the selected period"
          />
        </ReportSurface>

        <Dialog open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Report run details</DialogTitle>
            </DialogHeader>
            {detailRow && (
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">When:</span>{" "}
                  {format(new Date(detailRow.created_at), "MMM d, yyyy HH:mm:ss")}
                </div>
                <div>
                  <span className="text-muted-foreground">Report:</span>{" "}
                  {reportLabel(detailRow.report_type)}{" "}
                  <span className="font-mono text-muted-foreground">
                    ({detailRow.report_type})
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  <Badge variant={statusTone(detailRow.status)} className="text-xs">
                    {detailRow.status}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Output size:</span>{" "}
                  {formatBytes(detailRow.byte_count)}
                </div>
                <div>
                  <span className="text-muted-foreground">Run hash:</span>{" "}
                  <span className="font-mono break-all">{detailRow.run_hash}</span>
                </div>
                {detailRow.user_id && (
                  <div>
                    <span className="text-muted-foreground">Actor:</span>{" "}
                    <span className="font-mono">{detailRow.user_id}</span>
                  </div>
                )}
                {detailRow.business_id && (
                  <div>
                    <span className="text-muted-foreground">Business:</span>{" "}
                    <span className="font-mono">{detailRow.business_id}</span>
                  </div>
                )}
                {detailRow.params_jsonb && (
                  <div className="space-y-1">
                    <div className="text-muted-foreground">
                      Parameters (exact set the rendition was built from):
                    </div>
                    <pre className="bg-background border rounded p-2 overflow-x-auto max-h-64">
                      {JSON.stringify(detailRow.params_jsonb, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </ReportPageLayout>
    </CompanyScopeGate>
  );
}

export default function ReportRunHistory() {
  return (
    <ReportFilterProvider>
      <ReportRunHistoryInner />
    </ReportFilterProvider>
  );
}
