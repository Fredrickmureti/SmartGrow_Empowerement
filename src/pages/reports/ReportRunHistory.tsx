/**
 * Report Run History — the reader for `report_run_log` (Phase G).
 *
 * Every rendition produced by the canonical reporting engine writes a row to
 * `report_run_log` (actor, org, business, report type, params, row/byte count,
 * status, run hash). Until now that table had six writers and no reader: the
 * audit existed but nobody could see it. This page is that reader.
 *
 * Presentation follows the way mature ERPs render audit logs (Odoo's mail
 * tracking / SAP's change documents / NetSuite's system notes): the log reads
 * as *business facts in business language* — who did what, to which data, for
 * which period, and what came out. Machine handles (row UUIDs, actor UUIDs,
 * the `run_hash` fingerprint, the raw `params_jsonb`) are never the primary
 * reading surface; they live behind a "Technical details" disclosure in the
 * row detail, where a forensic reader can still reproduce or fingerprint the
 * run. Nothing is discarded — it is ranked.
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, ChevronDown } from "lucide-react";
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
  if (hit?.name) return hit.name;
  // Unregistered key: still render it as a sentence, never as a raw slug.
  return reportType
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  const s = status.toLowerCase();
  if (s === "error" || s === "failed") return "destructive";
  if (s === "ok" || s === "success" || s === "completed") return "secondary";
  return "outline";
}

/** Business wording for the outcome — auditors read "Completed", not "ok". */
function statusLabel(status: string): string {
  const s = (status || "").toLowerCase();
  if (s === "ok" || s === "success" || s === "completed") return "Completed";
  if (s === "error" || s === "failed") return "Failed";
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Delivery medium in the words the user chose in the UI. */
const OUTPUT_LABELS: Record<string, string> = {
  pdf: "PDF document",
  csv: "CSV export",
  xlsx: "Excel export",
  excel: "Excel export",
  json: "On-screen view",
  screen: "On-screen view",
  print: "Printed",
};

function outputLabel(params: Record<string, unknown> | null): string {
  const raw = params?.output_format ?? params?.format ?? params?.outputFormat;
  const key = typeof raw === "string" ? raw.toLowerCase() : "";
  return OUTPUT_LABELS[key] ?? (key ? key.toUpperCase() : "PDF document");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMachineHandle(key: string, value: unknown): boolean {
  if (typeof value === "string" && UUID_RE.test(value)) return true;
  return /(^|_)(id|ids|uuid|hash|token)$/i.test(key);
}

function prettyDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return format(d, "MMM d, yyyy");
}

/** "1 Jan 2026 – 31 Mar 2026", "As of 31 Mar 2026", or null when undated. */
function periodLabel(params: Record<string, unknown> | null): string | null {
  if (!params) return null;
  const range = (params.dateRange ?? params.date_range) as
    | Record<string, unknown>
    | undefined;
  const from =
    prettyDate(params.date_from ?? params.dateFrom ?? params.from ?? range?.from);
  const to = prettyDate(params.date_to ?? params.dateTo ?? params.to ?? range?.to);
  const asOf = prettyDate(params.as_of_date ?? params.asOfDate ?? params.as_of);
  if (from && to) return `${from} – ${to}`;
  if (asOf) return `As of ${asOf}`;
  if (from) return `From ${from}`;
  if (to) return `Up to ${to}`;
  return null;
}

function rowCount(params: Record<string, unknown> | null): number | null {
  const v = params?.row_count ?? params?.rowCount;
  return typeof v === "number" ? v : null;
}

function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function humanizeValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "string") return prettyDate(v) && /\d{4}-\d{2}-\d{2}/.test(v)
    ? (prettyDate(v) as string)
    : v.replace(/[_-]+/g, " ");
  return JSON.stringify(v);
}

/** Keys already promoted into named fields — never repeat them as "settings". */
const PROMOTED_KEYS = new Set([
  "output_format", "format", "outputFormat",
  "row_count", "rowCount",
  "date_from", "dateFrom", "from",
  "date_to", "dateTo", "to",
  "as_of_date", "asOfDate", "as_of",
  "dateRange", "date_range",
]);

/** The readable remainder of `params_jsonb`: real report settings only. */
function settingEntries(
  params: Record<string, unknown> | null,
): Array<[string, string]> {
  if (!params) return [];
  return Object.entries(params)
    .filter(([k, v]) => !PROMOTED_KEYS.has(k) && !isMachineHandle(k, v))
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [humanizeKey(k), humanizeValue(v)] as [string, string]);
}

function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Label-over-value pair — the detail dialog's only layout primitive. */
function Field({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 break-all font-mono text-xs" : "mt-0.5"}>{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ReportRunHistoryInner() {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(now), "yyyy-MM-dd"));
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailRow, setDetailRow] = useState<ReportRunRow | null>(null);

  const { currentOrg } = useOrganization();
  const { currentBusiness, businesses } = useBusinesses();

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

  // Actor names: a run log that says "who ran it" must say a person's name.
  const actorIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of data || []) if (r.user_id) s.add(r.user_id);
    return Array.from(s).sort();
  }, [data]);

  const { data: actorNames } = useQuery({
    queryKey: ["report-run-actors", actorIds],
    enabled: actorIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data: rows, error: e } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", actorIds);
      if (e) throw e;
      const map: Record<string, string> = {};
      for (const p of rows || []) {
        map[p.user_id] = p.full_name || p.email || "";
      }
      return map;
    },
  });

  const actorLabel = useCallback(
    (userId: string | null): string =>
      (userId && actorNames?.[userId]) || (userId ? "Unknown user" : "System"),
    [actorNames],
  );

  const companyLabel = useCallback(
    (businessId: string | null): string | null =>
      businessId
        ? businesses.find((b) => b.id === businessId)?.name ?? "Other company"
        : null,
    [businesses],
  );

  const rawById = useMemo(() => {
    const m = new Map<string, ReportRunRow>();
    for (const r of data || []) m.set(r.id, r);
    return m;
  }, [data]);

  const columns = useMemo<ReportColumn<ReportRunRow>[]>(
    () => [
      { key: "when", header: "Date & time", width: "w-[150px]" },
      { key: "report", header: "Report" },
      { key: "period", header: "Period covered", width: "w-[190px]" },
      { key: "company", header: "Company", width: "w-[160px]" },
      { key: "output", header: "Output", width: "w-[130px]" },
      { key: "lines", header: "Lines", width: "w-[80px]", align: "right" },
      { key: "actor", header: "Run by", width: "w-[170px]" },
      {
        key: "result",
        header: "Result",
        width: "w-[110px]",
        render: (row) => {
          const raw = rawById.get(String(row.id));
          if (!raw) return null;
          return (
            <Badge variant={statusTone(raw.status)} className="font-normal">
              {statusLabel(raw.status)}
            </Badge>
          );
        },
      },
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
              aria-label="View run details"
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
          period: periodLabel(r.params_jsonb),
          company: companyLabel(r.business_id) ?? "All companies",
          output: outputLabel(r.params_jsonb),
          lines: rowCount(r.params_jsonb),
          actor: actorLabel(r.user_id),
          result: statusLabel(r.status),
        },
      })),
    [data, actorLabel, companyLabel],
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
        description="Who ran which report, for which period and company, and what it produced"
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
                    {statusLabel(s)}
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
          subtitle={`${(data?.length || 0).toLocaleString("en-US")} runs shown (most recent 1,000)`}
          profile="operational"
        >
          <ReportTable
            columns={columns as ReportColumn<never>[]}
            rows={rows}
            caption="Report runs recorded for this organization"
            emptyMessage="No report runs found for the selected period"
          />
        </ReportSurface>

        <Dialog open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {detailRow ? reportLabel(detailRow.report_type) : "Report run"}
              </DialogTitle>
            </DialogHeader>
            {detailRow && (
              <div className="space-y-4 text-sm">
                {/* The one-sentence account of the event, as a system note. */}
                <p className="text-muted-foreground">
                  {actorLabel(detailRow.user_id)} produced a{" "}
                  {outputLabel(detailRow.params_jsonb).toLowerCase()} of{" "}
                  <span className="text-foreground">
                    {reportLabel(detailRow.report_type)}
                  </span>
                  {periodLabel(detailRow.params_jsonb)
                    ? ` for ${periodLabel(detailRow.params_jsonb)}`
                    : ""}
                  {companyLabel(detailRow.business_id)
                    ? ` (${companyLabel(detailRow.business_id)})`
                    : ""}{" "}
                  on {format(new Date(detailRow.created_at), "MMMM d, yyyy 'at' HH:mm")}.
                </p>

                <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <Field label="Run by" value={actorLabel(detailRow.user_id)} />
                  <Field
                    label="Date & time"
                    value={format(new Date(detailRow.created_at), "MMMM d, yyyy HH:mm:ss")}
                  />
                  <Field
                    label="Period covered"
                    value={periodLabel(detailRow.params_jsonb) ?? "Not period-bound"}
                  />
                  <Field
                    label="Company"
                    value={companyLabel(detailRow.business_id) ?? "All companies"}
                  />
                  <Field label="Output" value={outputLabel(detailRow.params_jsonb)} />
                  <Field
                    label="Lines produced"
                    value={
                      rowCount(detailRow.params_jsonb) !== null
                        ? rowCount(detailRow.params_jsonb)!.toLocaleString("en-US")
                        : "—"
                    }
                  />
                  <Field label="File size" value={formatBytes(detailRow.byte_count)} />
                  <div>
                    <dt className="text-xs text-muted-foreground">Result</dt>
                    <dd className="mt-0.5">
                      <Badge variant={statusTone(detailRow.status)} className="font-normal">
                        {statusLabel(detailRow.status)}
                      </Badge>
                    </dd>
                  </div>
                </dl>

                {settingEntries(detailRow.params_jsonb).length > 0 && (
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Report settings used
                    </h4>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                      {settingEntries(detailRow.params_jsonb).map(([k, v]) => (
                        <Field key={k} label={k} value={v} />
                      ))}
                    </dl>
                  </div>
                )}

                {/* Machine handles stay available for forensics, but ranked last. */}
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronDown className="h-3.5 w-3.5" />
                    Technical details
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 space-y-2 text-xs">
                    <Field label="Report key" value={detailRow.report_type} mono />
                    <Field
                      label="Run fingerprint"
                      value={detailRow.run_hash || "—"}
                      mono
                      hint="Two runs with the same fingerprint produced identical figures."
                    />
                    {detailRow.user_id && (
                      <Field label="User ID" value={detailRow.user_id} mono />
                    )}
                    {detailRow.business_id && (
                      <Field label="Company ID" value={detailRow.business_id} mono />
                    )}
                    {detailRow.params_jsonb && (
                      <div>
                        <dt className="text-muted-foreground">Raw parameters</dt>
                        <pre className="mt-1 max-h-64 overflow-x-auto rounded border bg-muted/40 p-2">
                          {JSON.stringify(detailRow.params_jsonb, null, 2)}
                        </pre>
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
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
