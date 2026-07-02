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
 */

import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const toggle = (id: string) => {
    const n = new Set(expanded);
    if (n.has(id)) n.delete(id); else n.add(id);
    setExpanded(n);
  };

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = (data || []).map((r) => ({
      when: format(new Date(r.occurred_at), "yyyy-MM-dd HH:mm"),
      source: sourceLabel(r.source_table),
      action: r.action || "",
      entity_type: r.entity_type || "",
      entity_id: r.entity_id || "",
      summary: r.summary || "",
      actor: r.actor_id || "",
    }));
    return {
      title: "Audit Trail",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: [
        { key: "when", header: "When", width: 16 },
        { key: "source", header: "Source", width: 18 },
        { key: "action", header: "Action", width: 14 },
        { key: "entity_type", header: "Entity", width: 16 },
        { key: "entity_id", header: "Entity ID", width: 20 },
        { key: "summary", header: "Summary", width: 36 },
        { key: "actor", header: "Actor", width: 20 },
      ],
      rows,
      sheetName: "Audit Trail",
    };
  }, [data, dateFrom, dateTo, currentOrg]);

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
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{data?.length || 0} audit events (capped at 1,000)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>When</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.map((r) => {
                  const isOpen = expanded.has(r.id);
                  return (
                    <Collapsible key={`${r.source_table}:${r.id}`} open={isOpen} onOpenChange={() => toggle(r.id)} asChild>
                      <>
                        <CollapsibleTrigger asChild>
                          <TableRow className="cursor-pointer hover:bg-muted/50">
                            <TableCell>
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </TableCell>
                            <TableCell className="font-mono text-xs whitespace-nowrap">
                              {format(new Date(r.occurred_at), "MMM d, yyyy HH:mm")}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">{sourceLabel(r.source_table)}</Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{r.action || "—"}</TableCell>
                            <TableCell className="text-sm">
                              {r.entity_type ? <span className="text-muted-foreground">{r.entity_type}</span> : "—"}
                              {r.entity_id && <span className="ml-1 font-mono text-xs">{r.entity_id.slice(0, 8)}…</span>}
                            </TableCell>
                            <TableCell className="text-sm max-w-[420px] truncate">{r.summary || "—"}</TableCell>
                          </TableRow>
                        </CollapsibleTrigger>
                        <CollapsibleContent asChild>
                          <TableRow className="bg-muted/20">
                            <TableCell />
                            <TableCell colSpan={5}>
                              <div className="space-y-2 py-2 text-xs">
                                {r.actor_id && (
                                  <div><span className="text-muted-foreground">Actor:</span> <span className="font-mono">{r.actor_id}</span></div>
                                )}
                                {r.entity_id && (
                                  <div><span className="text-muted-foreground">Entity ID:</span> <span className="font-mono">{r.entity_id}</span></div>
                                )}
                                {r.payload && (
                                  <pre className="bg-background border rounded p-2 overflow-x-auto max-h-64">
                                    {JSON.stringify(r.payload, null, 2)}
                                  </pre>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        </CollapsibleContent>
                      </>
                    </Collapsible>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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
