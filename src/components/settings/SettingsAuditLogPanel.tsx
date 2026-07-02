/**
 * SettingsAuditLogPanel — read-only view of recent sensitive setting changes
 * for the current organization. Sourced from `settings_audit_log` (populated
 * by SECURITY DEFINER triggers, see migration 20260427).
 */
import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { History, ShieldCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useSettingsAuditLog } from "@/hooks/useSettingsAuditLog";
import { AuditDiff, humanizeKey } from "@/components/audit/auditFormat";
import { ClearAuditLogsDialog } from "@/components/audit/ClearAuditLogsDialog";
import { useSession } from "@/contexts/SessionContext";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";


const SCOPE_LABELS: Record<string, string> = {
  business: "Business",
  branch: "Branch",
  tax: "Tax",
  payments: "Payments",
  accounting: "Accounting",
  notifications: "Notifications",
  pos: "POS",
};

// (Field-level diffing handled by <AuditDiff />)

export function SettingsAuditLogPanel() {
  const [scope, setScope] = useState<string>("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;
  const { entries, isLoading } = useSettingsAuditLog({ scope: scope || undefined, limit: 500 });
  const { currentOrg, userRole } = useSession();
  const queryClient = useQueryClient();
  const canClear = userRole === "owner" || userRole === "admin";

  useEffect(() => {
    setPage(1);
  }, [scope, entries.length]);

  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const pagedEntries = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const grouped = useMemo(() => {
    const buckets: Record<string, typeof entries> = {};
    for (const e of pagedEntries) {
      const day = new Date(e.created_at).toISOString().slice(0, 10);
      (buckets[day] ||= []).push(e);
    }
    return Object.entries(buckets).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [pagedEntries]);

  const handleClear = async (olderThanDays: number | null) => {
    if (!currentOrg?.id) throw new Error("No organization selected");
    const { data, error } = await (supabase as any).rpc("clear_settings_audit_log", {
      p_org_id: currentOrg.id,
      p_older_than_days: olderThanDays,
    });
    if (error) throw new Error(error.message);
    await queryClient.invalidateQueries({ queryKey: ["settings-audit-log"] });
    return (data as number) ?? 0;
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" /> Settings audit log
          </CardTitle>
          <CardDescription>
            Sensitive setting changes for this organization. Inserted automatically by the database — cannot be edited from the UI.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {canClear && (
            <ClearAuditLogsDialog onConfirm={handleClear} scopeLabel="this organization's" />
          )}
          <Select value={scope} onValueChange={(v) => setScope(v === "all" ? "" : v)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All scopes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All scopes</SelectItem>
              {Object.entries(SCOPE_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading audit entries…</p>}
        {!isLoading && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10 text-center">
            <ShieldCheck className="h-6 w-6 text-muted-foreground mb-2" />
            <p className="text-sm font-medium">No sensitive changes recorded yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Edits to taxes, payments, accounting defaults, branch overrides and identity will appear here.
            </p>
          </div>
        )}
        {grouped.map(([day, items]) => (
          <div key={day} className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{day}</p>
            <div className="space-y-2">
              {items.map((e) => (
                <div key={e.id} className="rounded-lg border bg-card p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px] uppercase">{SCOPE_LABELS[e.setting_scope] ?? e.setting_scope}</Badge>
                    <span className="font-medium">{humanizeKey(e.setting_key || e.table_name || "")}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <AuditDiff oldValue={e.old_value} newValue={e.new_value} />
                </div>
              ))}
            </div>
          </div>
        ))}
        {entries.length > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground border-t">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, entries.length)} of {entries.length}
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
              <span>Page {page} / {totalPages}</span>
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
        )}
      </CardContent>
    </Card>
  );
}
