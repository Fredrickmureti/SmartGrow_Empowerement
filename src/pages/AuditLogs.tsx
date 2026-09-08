import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { downloadCsv } from "@/lib/exports/csv";
import { PlatformAppLayout } from "@/apps/platform";
import { useAuditLogsPaginated, AuditLogFilters } from "@/hooks/useAuditLogsPaginated";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useOrganization } from "@/hooks/useOrganization";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { supabase } from "@/integrations/supabase/client";
import { SettingsAuditLogPanel } from "@/components/settings/SettingsAuditLogPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DetailSheet, StatusBadge } from "@/design-system";
import {
  Search,
  History,
  Loader2,
  Eye,
  Download,
  Filter,
  Trash2,
  Copy,
  Settings as SettingsIcon,
  Scale,
  Activity,
} from "lucide-react";

import { format } from "date-fns";
import { toast } from "sonner";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { normalizeError } from "@/services/resilience";
import {
  humanizeEntityType,
  humanizeAction,
  humanizeSentence,
  formatFieldName,
  formatFieldValue,
  diffValues,
} from "./audit-logs/format";

interface AuditLogDetail {
  id: string;
  user_id?: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changes_summary: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export default function AuditLogs() {
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const [searchInput, setSearchInput] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const { currentOrg } = useOrganization();
  const { getUserName, members } = useOrgMembers();

  const userRole = currentOrg?.role;
  const isAdmin = userRole === "owner" || userRole === "admin";

  const debouncedSearch = useDebouncedCallback((value: string) => {
    setFilters((prev) => ({ ...prev, search: value || undefined }));
  }, 300);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  const {
    auditLogs,
    entityTypes,
    actions,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    refetch,
  } = useAuditLogsPaginated(filters);

  const [selectedLog, setSelectedLog] = useState<AuditLogDetail | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showTechnicalFields, setShowTechnicalFields] = useState(false);

  const handleClearAllLogs = async () => {
    if (!currentOrg?.id) return;
    setIsClearing(true);
    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: workspace-wide audit log clear by admin
        .from("audit_logs")
        .delete()
        .eq("organization_id", currentOrg.id)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("Deletion was blocked by security policy. You may not have admin permissions.");
      }
      toast.success(`Cleared ${data.length} audit log entries`);
      refetch();
    } catch (error: any) {
      console.error("Error clearing audit logs:", error);
      toast.error(normalizeError(error).message || "Failed to clear audit logs");
    } finally {
      setIsClearing(false);
    }
  };

  const handleExportCSV = () => {
    const headers = [
      "Date",
      "User",
      "Action",
      "Entity",
      "Name",
      "Summary",
      "action_raw",
      "entity_type_raw",
    ];
    const rows = auditLogs.map((log) => [
      format(new Date(log.created_at), "yyyy-MM-dd HH:mm:ss"),
      getUserName(log.user_id),
      humanizeAction(log.action).label,
      humanizeEntityType(log.entity_type),
      log.entity_name || "",
      log.changes_summary ||
        humanizeSentence({
          action: log.action,
          entityType: log.entity_type,
          entityName: log.entity_name,
        }),
      log.action,
      log.entity_type,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    downloadCsv(`audit-logs-${format(new Date(), "yyyy-MM-dd")}.csv`, csv);
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Copy failed");
    }
  };

  const diff = selectedLog
    ? diffValues(selectedLog.old_values, selectedLog.new_values, {
        includeNoise: showTechnicalFields,
      })
    : [];

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: "activity" | "settings" | "legal-orders" =
    tabParam === "settings" || tabParam === "legal-orders" ? tabParam : "activity";
  const setActiveTab = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v === "activity") next.delete("tab");
    else next.set("tab", v);
    setSearchParams(next, { replace: true });
  };

  return (
    <PlatformAppLayout>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Audit Logs</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              A single audit surface for every governance-relevant change in your organization.
            </p>
          </div>
          {activeTab === "activity" && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowFilters(!showFilters)}>
                <Filter className="mr-2 h-4 w-4" />
                Filters
              </Button>
              <Button variant="outline" onClick={handleExportCSV}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
              <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      disabled={isClearing}
                      className={isAdmin && auditLogs.length > 0 ? undefined : "hidden"}
                    >
                      {isClearing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="mr-2 h-4 w-4" />
                      )}
                      Clear All
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Clear All Audit Logs</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete all audit logs for this organization.
                        This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleClearAllLogs}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Clear All Logs
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4 sm:space-y-6">
          <TabsList>
            <TabsTrigger value="activity" className="gap-1.5">
              <Activity className="h-3.5 w-3.5" />
              Activity
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5">
              <SettingsIcon className="h-3.5 w-3.5" />
              Settings changes
            </TabsTrigger>
            <TabsTrigger value="legal-orders" className="gap-1.5">
              <Scale className="h-3.5 w-3.5" />
              Legal orders
            </TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="space-y-4">
            <SettingsAuditLogPanel />
          </TabsContent>


          <TabsContent value="activity" className="space-y-4 sm:space-y-6">


        {/* Filters Panel */}
        {showFilters && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Filters</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-5">
                <div className="space-y-2">
                  <Label>User</Label>
                  <Select
                    value={filters.userId || "all"}
                    onValueChange={(v) =>
                      setFilters((prev) => ({ ...prev, userId: v === "all" ? undefined : v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All users" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Users</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Entity</Label>
                  <Select
                    value={filters.entityType || "all"}
                    onValueChange={(v) =>
                      setFilters((prev) => ({ ...prev, entityType: v === "all" ? undefined : v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All entities" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Entities</SelectItem>
                      {entityTypes.map((type: any) => (
                        <SelectItem key={String(type)} value={String(type)}>
                          {humanizeEntityType(String(type))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Action</Label>
                  <Select
                    value={filters.action || "all"}
                    onValueChange={(v) =>
                      setFilters((prev) => ({ ...prev, action: v === "all" ? undefined : v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All actions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Actions</SelectItem>
                      {actions.map((action: any) => (
                        <SelectItem key={String(action)} value={String(action)}>
                          {humanizeAction(String(action)).label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={filters.startDate || ""}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, startDate: e.target.value || undefined }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Date</Label>
                  <Input
                    type="date"
                    value={filters.endDate || ""}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, endDate: e.target.value || undefined }))
                    }
                  />
                </div>
              </div>
              <div className="flex justify-end mt-4">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setFilters({});
                    setSearchInput("");
                  }}
                >
                  Clear Filters
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search logs..."
              value={searchInput}
              onChange={handleSearchChange}
              className="pl-10"
            />
          </div>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : auditLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <History className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No audit logs found</h3>
                <p className="text-muted-foreground">Changes will be recorded here</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="max-w-xs">What happened</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((log) => {
                    const action = humanizeAction(log.action);
                    const summary =
                      log.changes_summary ||
                      humanizeSentence({
                        action: log.action,
                        entityType: log.entity_type,
                        entityName: log.entity_name,
                      });
                    return (
                      <TableRow key={log.id} className="cursor-pointer" onClick={() => setSelectedLog(log)}>
                        <TableCell className="whitespace-nowrap text-sm">
                          {format(new Date(log.created_at), "MMM d, yyyy HH:mm")}
                        </TableCell>
                        <TableCell className="text-sm">{getUserName(log.user_id) || "System"}</TableCell>
                        <TableCell>
                          <StatusBadge tone={action.tone}>{action.label}</StatusBadge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" title={log.entity_type}>
                            {humanizeEntityType(log.entity_type)}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-medium">{log.entity_name || "—"}</TableCell>
                        <TableCell className="max-w-xs truncate text-muted-foreground">{summary}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLog(log);
                            }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {auditLogs.length > 0 && (
          <DataTablePagination
            pagination={pagination}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            isLoading={isFetching}
          />
        )}

        {/* Detail Sheet — always mounted; open bound to !!selectedLog */}
        <DetailSheet
          open={!!selectedLog}
          onOpenChange={(open) => {
            if (!open) setSelectedLog(null);
          }}
          size="lg"
          title={
            selectedLog
              ? humanizeSentence({
                  action: selectedLog.action,
                  entityType: selectedLog.entity_type,
                  entityName: selectedLog.entity_name,
                })
              : "Audit entry"
          }
          description={
            selectedLog
              ? format(new Date(selectedLog.created_at), "MMMM d, yyyy 'at' HH:mm:ss")
              : undefined
          }
          headerActions={
            selectedLog && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyToClipboard(selectedLog.id, "Log ID")}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  ID
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copyToClipboard(
                      JSON.stringify(
                        {
                          old_values: selectedLog.old_values,
                          new_values: selectedLog.new_values,
                        },
                        null,
                        2,
                      ),
                      "JSON",
                    )
                  }
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  JSON
                </Button>
              </>
            )
          }
        >
          {selectedLog && (
            <div className="space-y-6">
              {/* Summary strip */}
              <div className="grid gap-3 sm:grid-cols-2">
                <SummaryItem label="Action">
                  <StatusBadge tone={humanizeAction(selectedLog.action).tone}>
                    {humanizeAction(selectedLog.action).label}
                  </StatusBadge>
                </SummaryItem>
                <SummaryItem label="Entity">
                  {humanizeEntityType(selectedLog.entity_type)}
                </SummaryItem>
                {selectedLog.entity_name && (
                  <SummaryItem label="Record">{selectedLog.entity_name}</SummaryItem>
                )}
                <SummaryItem label="User">{getUserName(selectedLog.user_id) || "System"}</SummaryItem>
                {selectedLog.entity_id && (
                  <SummaryItem label="Record ID">
                    <span className="font-mono text-xs">{selectedLog.entity_id}</span>
                  </SummaryItem>
                )}
                {selectedLog.ip_address && (
                  <SummaryItem label="IP address">
                    <span className="font-mono text-xs">{selectedLog.ip_address}</span>
                  </SummaryItem>
                )}
              </div>

              {selectedLog.changes_summary && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Summary
                  </div>
                  <p className="text-sm">{selectedLog.changes_summary}</p>
                </div>
              )}

              {/* Field-level diff */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Changes
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      id="tech-fields"
                      checked={showTechnicalFields}
                      onCheckedChange={setShowTechnicalFields}
                    />
                    <Label htmlFor="tech-fields" className="cursor-pointer text-xs">
                      Show technical fields
                    </Label>
                  </div>
                </div>
                {diff.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No field changes recorded.</p>
                ) : (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Field</th>
                          <th className="text-left px-3 py-2 font-medium">Before</th>
                          <th className="text-left px-3 py-2 font-medium">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.map((entry) => (
                          <tr key={entry.key} className="border-t align-top">
                            <td className="px-3 py-2 font-medium">{formatFieldName(entry.key)}</td>
                            <td className="px-3 py-2 text-muted-foreground line-through decoration-muted-foreground/40">
                              {formatFieldValue(entry.key, entry.before)}
                            </td>
                            <td className="px-3 py-2">
                              {formatFieldValue(entry.key, entry.after)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {selectedLog.user_agent && (
                <SummaryItem label="User agent">
                  <span className="text-xs text-muted-foreground break-all">
                    {selectedLog.user_agent}
                  </span>
                </SummaryItem>
              )}

              {/* Raw JSON — collapsed by default */}
              <details className="rounded-md border bg-muted/30">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                  Raw payload (for engineers)
                </summary>
                <pre className="px-3 py-2 text-xs overflow-x-auto">
                  {JSON.stringify(
                    { old_values: selectedLog.old_values, new_values: selectedLog.new_values },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
          )}
        </DetailSheet>
          </TabsContent>
        </Tabs>
      </div>
    </PlatformAppLayout>
  );
}


function SummaryItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-0.5">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
