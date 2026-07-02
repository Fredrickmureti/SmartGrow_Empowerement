// @ts-nocheck
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ClipboardList,
  Search,
  RefreshCw,
  Loader2,
  Activity,
  Filter,
  ChevronDown,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { AuditDetails, humanizeAction, humanizeKey, actionVariant } from "@/components/audit/auditFormat";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ClearAuditLogsDialog } from "@/components/audit/ClearAuditLogsDialog";

interface AuditEntry {
  id: string;
  admin_user_id: string | null;
  action_type: string;
  target_org_id: string | null;
  target_entity_type: string | null;
  target_entity_id: string | null;
  details: any;
  created_at: string;
}

export default function AdminAuditLog() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("all");

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  const fetchLogs = async () => {
    setIsLoading(true);
    try {
      let query = (supabase.from as any)("admin_audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);

      if (actionFilter !== "all") {
        query = query.eq("action_type", actionFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      setLogs(data || []);
    } catch (error) {
      console.error("Error fetching audit logs:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    setPage(1);
  }, [actionFilter]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  const filteredLogs = logs.filter((log) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      log.action_type.toLowerCase().includes(q) ||
      log.target_entity_type?.toLowerCase().includes(q) ||
      JSON.stringify(log.details).toLowerCase().includes(q)
    );
  });

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const pagedLogs = filteredLogs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const uniqueActions = [...new Set(logs.map((l) => l.action_type))];

  const handleClear = async (olderThanDays: number | null) => {
    const { data, error } = await (supabase as any).rpc("clear_admin_audit_log", {
      p_older_than_days: olderThanDays,
    });
    if (error) throw new Error(error.message);
    await fetchLogs();
    return (data as number) ?? 0;
  };

  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight flex items-center gap-2">
              <ClipboardList className="h-5 w-5 sm:h-6 sm:w-6" />
              Audit Log
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Track all platform admin actions
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ClearAuditLogsDialog onConfirm={handleClear} scopeLabel="the platform" />
            <Button variant="outline" size="sm" onClick={fetchLogs} disabled={isLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="p-3 sm:p-6">
            <div className="flex flex-col sm:flex-row gap-2">
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="w-full sm:w-48 text-xs sm:text-sm h-8 sm:h-9">
                  <Filter className="h-3 w-3 mr-1.5" />
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  {uniqueActions.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 text-xs sm:text-sm h-8 sm:h-9"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="text-center py-12">
                <Activity className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No audit log entries found</p>
              </div>
            ) : (
              <div className="space-y-2">
                {pagedLogs.map((log) => {
                  const hasDetails =
                    log.details && typeof log.details === "object" && Object.keys(log.details).length > 0;
                  return (
                    <Collapsible key={log.id}>
                      <div className="rounded-lg border bg-card p-3 sm:p-4 hover:bg-accent/30 transition-colors">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={actionVariant(log.action_type)} className="text-xs">
                            {humanizeAction(log.action_type)}
                          </Badge>
                          {log.target_entity_type && (
                            <span className="text-sm text-muted-foreground">
                              on{" "}
                              <span className="font-medium text-foreground">
                                {humanizeKey(log.target_entity_type)}
                              </span>
                              {log.target_entity_id && (
                                <span className="font-mono text-xs ml-1 text-muted-foreground">
                                  #{log.target_entity_id.slice(0, 8)}
                                </span>
                              )}
                            </span>
                          )}
                          <span
                            className="ml-auto text-xs text-muted-foreground whitespace-nowrap"
                            title={format(new Date(log.created_at), "PPpp")}
                          >
                            {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        {hasDetails && (
                          <div className="mt-2">
                            <AuditDetails details={log.details} />
                          </div>
                        )}
                        {hasDetails && (
                          <CollapsibleTrigger asChild>
                            <button className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                              <ChevronDown className="h-3 w-3 transition-transform data-[state=open]:rotate-180" />
                              Raw payload
                            </button>
                          </CollapsibleTrigger>
                        )}
                        <CollapsibleContent>
                          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">
                            {JSON.stringify(log.details, null, 2)}
                          </pre>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  );
                })}
                <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
                  <span>
                    Showing {(page - 1) * PAGE_SIZE + 1}–
                    {Math.min(page * PAGE_SIZE, filteredLogs.length)} of {filteredLogs.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                    >
                      Previous
                    </Button>
                    <span>
                      Page {page} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
