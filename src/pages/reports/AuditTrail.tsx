/**
 * Audit Trail Report Page — unified view over `v_unified_audit`.
 *
 * Phase A3: previously this page read only `journal_entries`, ignoring six
 * other audit log tables (account_change_audit_log, settings_audit_log,
 * commercial_audit_logs, default_account_mapping_audit, timesheet_audit_log,
 * signature_audit_log, pack_audit_log). The migration that introduced
 * `v_unified_audit` UNIONs all seven sources into one row shape; this page
 * now consumes that view directly so real audits can answer
 * "who changed what, when, in which module" from a single surface.
 *
 * The view is `security_invoker = on`, so RLS on every underlying table is
 * still enforced as the caller.
 *
 * Rendered by the canonical reporting engine. The old row-expansion UX for
 * inspecting the raw payload now lives in a detail dialog opened from an
 * action button, since the engine's row model has no expandable-row kind.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
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

interface UnifiedAuditRow {
  id: string;
  source_table: string;
  organization_id: string | null;
  business_id: string | null;
  actor_id: string | null;
  action: string | null;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: string;
}

const SOURCE_LABELS: Record<string, string> = {
  audit_logs: "General",
  account_change_audit_log: "Chart of Accounts",
  settings_audit_log: "Settings",
  commercial_audit_logs: "Commercial",
  default_account_mapping_audit: "Default Accounts",
  timesheet_audit_log: "Timesheets",
  signature_audit_log: "Signatures",
  pack_audit_log: "Localization Packs",
};

function sourceLabel(s: string | null) {
  if (!s) return "—";
  return SOURCE_LABELS[s] ?? s;
}

function AuditTrailInner() {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(now), "yyyy-MM-dd"));
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [detailRow, setDetailRow] = useState<UnifiedAuditRow | null>(null);

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { filters: _filters } = useReportFilters();

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "audit-trail-unified",
      currentOrg?.id,
      currentBusiness?.id,
      dateFrom,
      dateTo,
      sourceFilter,
      actionFilter,
    ],
    queryFn: async (): Promise<UnifiedAuditRow[]> => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("v_unified_audit" as any)
        .select(
          "id, source_table, organization_id, business_id, actor_id, action, entity_type, entity_id, summary, payload, occurred_at",
        )
        .eq("organization_id", currentOrg.id)
        .gte("occurred_at", `${dateFrom}T00:00:00`)
        .lte("occurred_at", `${dateTo}T23:59:59`)
        .order("occurred_at", { ascending: false })
        .limit(1000);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (sourceFilter !== "all") q = q.eq("source_table", sourceFilter);
      if (actionFilter !== "all") q = q.eq("action", actionFilter);
      const { data: rows, error: e } = await q;
      if (e) throw e;
      return (rows || []) as unknown as UnifiedAuditRow[];
    },
    enabled: !!currentOrg?.id,
  });

  const actionOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of data || []) if (r.action) s.add(r.action);
    return Array.from(s).sort();
  }, [data]);

  const rawById = useMemo(() => {
    const m = new Map<string, UnifiedAuditRow>();
    for (const r of data || []) m.set(`${r.source_table}:${r.id}`, r);
    return m;
  }, [data]);

  const columns = useMemo<ReportColumn<UnifiedAuditRow>[]>(
    () => [
      { key: "when", header: "When", width: "w-[160px]" },
      { key: "source", header: "Source", width: "w-[160px]" },
      { key: "action", header: "Action", width: "w-[120px]" },
      { key: "entity", header: "Entity", width: "w-[220px]" },
      { key: "summary", header: "Summary" },
      {
        key: "detail",
        header: "",
        width: "w-[56px]",
        exportExclude: true,
        render: (row) => {
          const raw = rawById.get(row.id);
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
              aria-label="View audit event details"
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
        id: `${r.source_table}:${r.id}`,
        onClick: () => setDetailRow(r),
        values: {
          when: format(new Date(r.occurred_at), "MMM d, yyyy HH:mm"),
          source: sourceLabel(r.source_table),
          action: r.action || null,
          entity: r.entity_type
            ? `${r.entity_type}${r.entity_id ? ` · ${r.entity_id.slice(0, 8)}…` : ""}`
            : null,
          summary: r.summary || null,
        },
      })),
    [data],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    return {
      title: "Audit Trail",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns as ReportColumn<never>[]),
      rows: toExportRows(rows, columns as ReportColumn<never>[]),
      sheetName: "Audit Trail",
    };
  }, [columns, rows, dateFrom, dateTo, currentOrg]);

  return (
    <CompanyScopeGate reportName="Audit Trail">
      <ReportPageLayout
        title="Audit Trail"
        description="Unified audit log across all modules — accounting, settings, commercial, default accounts, timesheets, signatures, localization packs"
        isLoading={isLoading}
        error={error as Error | null}
        isEmpty={!data || data.length === 0}
        emptyMessage="No audit events found for the selected period"
        getExportConfig={getExportConfig}
        headerActions={
          <>
            <RefreshButton queryKeyPrefixes={[["audit-trail-unified"] as const]} tooltip="Refresh audit trail" />
            <SaveViewButton
              reportType="audit-trail"
              currentFilters={{ dateFrom, dateTo, sourceFilter, actionFilter }}
              onLoadView={(f) => {
                if (f.dateFrom) setDateFrom(f.dateFrom);
                if (f.dateTo) setDateTo(f.dateTo);
                if (f.sourceFilter) setSourceFilter(f.sourceFilter);
                if (f.actionFilter) setActionFilter(f.actionFilter);
              }}
            />
          </>
        }
        filters={
          <ReportFilters dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo}>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actionOptions.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ReportFilters>
        }
      >
        <ReportSurface
          companyName={currentOrg?.name || ""}
          title="Audit Trail"
          dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
          subtitle={`${data?.length || 0} audit events (capped at 1,000)`}
          profile="operational"
        >
          <ReportTable
            columns={columns as ReportColumn<never>[]}
            rows={rows}
            caption="Unified audit trail across all modules"
            emptyMessage="No audit events found for the selected period"
          />
        </ReportSurface>

        <Dialog open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Audit event details</DialogTitle>
            </DialogHeader>
            {detailRow && (
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">When:</span>{" "}
                  {format(new Date(detailRow.occurred_at), "MMM d, yyyy HH:mm")}
                </div>
                <div>
                  <span className="text-muted-foreground">Source:</span>{" "}
                  <Badge variant="outline" className="text-xs">{sourceLabel(detailRow.source_table)}</Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Action:</span>{" "}
                  <span className="font-mono">{detailRow.action || "—"}</span>
                </div>
                {detailRow.actor_id && (
                  <div><span className="text-muted-foreground">Actor:</span> <span className="font-mono">{detailRow.actor_id}</span></div>
                )}
                {detailRow.entity_id && (
                  <div><span className="text-muted-foreground">Entity ID:</span> <span className="font-mono">{detailRow.entity_id}</span></div>
                )}
                {detailRow.summary && (
                  <div><span className="text-muted-foreground">Summary:</span> {detailRow.summary}</div>
                )}
                {detailRow.payload && (
                  <pre className="bg-background border rounded p-2 overflow-x-auto max-h-64">
                    {JSON.stringify(detailRow.payload, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </ReportPageLayout>
    </CompanyScopeGate>
  );
}

export default function AuditTrail() {
  return (
    <ReportFilterProvider>
      <AuditTrailInner />
    </ReportFilterProvider>
  );
}
