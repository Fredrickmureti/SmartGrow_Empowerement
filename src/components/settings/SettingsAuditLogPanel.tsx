/**
 * SettingsAuditLogPanel — read-only view of recent sensitive setting changes
 * for the current organization.
 *
 * Renders through the shared audit-log primitives (`AuditLogTableView` +
 * `AuditEntryDrawer`) so this tab reads identically to the Activity tab.
 * Sourced from `settings_audit_log` (SECURITY DEFINER triggers) and
 * settings.* rows in `audit_logs` via `useSettingsAuditLog`.
 */
import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History } from "lucide-react";
import { format } from "date-fns";
import { useSettingsAuditLog, type SettingsAuditEntry } from "@/hooks/useSettingsAuditLog";
import { AuditDiff, humanizeKey } from "@/components/audit/auditFormat";
import { ClearAuditLogsDialog } from "@/components/audit/ClearAuditLogsDialog";
import { AuditLogTableView, type AuditEntry, type AuditActionTone } from "@/components/audit/AuditLogTableView";
import { AuditEntryDrawer, SummaryItem } from "@/components/audit/AuditEntryDrawer";
import { useSession } from "@/contexts/SessionContext";
import { useOrgMembers } from "@/hooks/useOrgMembers";
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

function classifyAction(e: SettingsAuditEntry): { label: string; tone: AuditActionTone } {
  const hasOld = e.old_value !== null && e.old_value !== undefined;
  const hasNew = e.new_value !== null && e.new_value !== undefined;
  if (!hasOld && hasNew) return { label: "Created", tone: "success" };
  if (hasOld && !hasNew) return { label: "Deleted", tone: "danger" };
  return { label: "Updated", tone: "info" };
}

function toAuditEntry(
  e: SettingsAuditEntry,
  getUserName: (id?: string | null) => string,
): AuditEntry {
  const scopeLabel = SCOPE_LABELS[e.setting_scope] ?? e.setting_scope;
  const settingLabel = humanizeKey(e.setting_key || e.table_name || "");
  const action = classifyAction(e);
  return {
    id: e.id,
    occurredAt: e.created_at,
    userLabel: getUserName(e.actor_id) || null,
    action,
    entity: { label: scopeLabel, raw: e.setting_scope },
    entityName: settingLabel || null,
    summary:
      e.reason ||
      `${action.label} ${settingLabel || "setting"}${scopeLabel ? ` (${scopeLabel})` : ""}`,
    raw: e,
  };
}

export function SettingsAuditLogPanel() {
  const [scope, setScope] = useState<string>("");
  const { entries, isLoading } = useSettingsAuditLog({
    scope: scope || undefined,
    limit: 500,
  });
  const { currentOrg, userRole } = useSession();
  const { getUserName } = useOrgMembers();
  const queryClient = useQueryClient();
  const canClear = userRole === "owner" || userRole === "admin";
  const [selected, setSelected] = useState<SettingsAuditEntry | null>(null);

  const rows: AuditEntry[] = useMemo(
    () => entries.map((e) => toAuditEntry(e, getUserName)),
    [entries, getUserName],
  );

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
    <>
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
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <AuditLogTableView
            entries={rows}
            isLoading={isLoading}
            onSelect={(entry) => setSelected(entry.raw as SettingsAuditEntry)}
            emptyTitle="No sensitive changes recorded yet"
            emptyHint="Edits to taxes, payments, accounting defaults, branch overrides and identity will appear here."
          />
        </CardContent>
      </Card>

      <AuditEntryDrawer
        entry={
          selected
            ? toAuditEntry(selected, getUserName)
            : null
        }
        onClose={() => setSelected(null)}
        rawJson={
          selected
            ? { old_value: selected.old_value, new_value: selected.new_value }
            : undefined
        }
        extraSummary={
          selected
            ? [
                {
                  label: "Setting key",
                  value: (
                    <span className="font-mono text-xs">
                      {selected.setting_key || selected.table_name || "—"}
                    </span>
                  ),
                },
                {
                  label: "When",
                  value: format(new Date(selected.created_at), "MMM d, yyyy HH:mm:ss"),
                },
                ...(selected.reason
                  ? [{ label: "Reason", value: selected.reason }]
                  : []),
              ]
            : undefined
        }
      >
        {selected && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              Changes
            </div>
            <AuditDiff oldValue={selected.old_value} newValue={selected.new_value} />
          </div>
        )}
      </AuditEntryDrawer>
    </>
  );
}
