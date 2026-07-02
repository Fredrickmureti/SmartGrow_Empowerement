/**
 * useSettingsAuditLog — read-only access to settings change history.
 *
 * Two upstream sources are unified into one shape:
 *   1. `settings_audit_log` — populated by SECURITY DEFINER triggers
 *      attached to sensitive settings tables (RBAC groups, business
 *      identity, tax/payments/accounting/notifications/POS).
 *   2. `audit_logs` — application-level inserts for branch overrides
 *      and other settings.* actions.
 *
 * Both are filtered by organization_id, ordered by created_at desc,
 * and projected to the SettingsAuditEntry shape that the panel
 * already renders.
 *
 * Writes are not exposed.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface SettingsAuditEntry {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  actor_id: string | null;
  setting_scope: string;
  setting_key: string;
  table_name: string;
  record_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  created_at: string;
}

interface Options {
  scope?: string;
  limit?: number;
}

/**
 * Map an `audit_logs` row whose action starts with `settings.` into
 * the shape the panel expects. The action is split into
 * `settings.<scope>.<verb>` (e.g. `settings.branch_overrides.update`)
 * so the scope chip lights up correctly.
 */
function projectAuditLog(row: Record<string, unknown>): SettingsAuditEntry {
  const action = String(row.action ?? "");
  const parts = action.split(".");
  const scope = parts[1] ?? "settings";
  const verb = parts.slice(2).join(".") || "change";
  return {
    id: `audit-${String(row.id)}`,
    organization_id: String(row.organization_id ?? ""),
    business_id: (row.business_id as string | null) ?? null,
    branch_id: (row.branch_id as string | null) ?? null,
    actor_id: (row.user_id as string | null) ?? null,
    setting_scope: scope,
    setting_key: (row.entity_name as string | null) || verb,
    table_name: (row.entity_type as string | null) ?? "",
    record_id: (row.entity_id as string | null) ?? null,
    old_value: row.old_values ?? null,
    new_value: row.new_values ?? null,
    reason: (row.changes_summary as string | null) ?? null,
    created_at: String(row.created_at ?? new Date().toISOString()),
  };
}

export function useSettingsAuditLog({ scope, limit = 100 }: Options = {}) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id ?? null;

  const query = useQuery<SettingsAuditEntry[]>({
    queryKey: ["settings-audit-log", orgId, businessId, scope, limit],
    enabled: !!orgId,
    staleTime: 30 * 1000,
    queryFn: async () => {
      if (!orgId) return [];

      // Source 1 — trigger-populated settings audit log.
      let primaryQ = (supabase as any)
        .from("settings_audit_log")
        .select("*")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (scope) primaryQ = primaryQ.eq("setting_scope", scope);
      const primary = primaryQ;

      // Source 2 — application-level audit_logs filtered to settings.*.
      // We pull a wider window then filter client-side so we don't lose
      // events when the user narrows by scope (e.g. branch_overrides).
      // Scope by business when one is active so the page doesn't leak
      // settings changes from sibling companies in the same workspace.
      let secondaryQ = (supabase as any)
        .from("audit_logs")
        .select(
          "id, organization_id, business_id, branch_id, user_id, action, entity_type, entity_id, entity_name, old_values, new_values, changes_summary, created_at",
        )
        .eq("organization_id", orgId)
        .like("action", "settings.%")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (businessId) secondaryQ = secondaryQ.eq("business_id", businessId);
      const secondary = secondaryQ;

      const [primaryRes, secondaryRes] = await Promise.all([primary, secondary]);

      if (primaryRes.error) throw primaryRes.error;
      // audit_logs may not be readable for every role — degrade gracefully.
      const secondaryRows = secondaryRes.error ? [] : (secondaryRes.data ?? []);

      const projected = (secondaryRows as Array<Record<string, unknown>>)
        .map(projectAuditLog)
        .filter((e) => (scope ? e.setting_scope === scope : true));

      const merged: SettingsAuditEntry[] = [
        ...((primaryRes.data ?? []) as SettingsAuditEntry[]),
        ...projected,
      ];

      // De-dupe defensively by (table_name, record_id, created_at).
      const seen = new Set<string>();
      const deduped = merged.filter((e) => {
        const key = `${e.table_name}|${e.record_id ?? ""}|${e.created_at}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Re-sort and cap.
      deduped.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return deduped.slice(0, limit);
    },
  });

  return {
    entries: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
