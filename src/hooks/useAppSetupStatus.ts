/**
 * useAppSetupStatus
 *
 * Reads `app_setup_status` rows for the current organization. The DB table
 * is updated by per-app refresh functions (e.g. `refresh_payroll_setup_status`)
 * and reflects whether an installed app is fully configured and usable.
 *
 * Surfaced on AppCard tiles ("Setup required: salary structure, statutory rules")
 * and inside per-app gates like <PayrollSetupGate>.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";

export interface AppSetupStatusRow {
  app_id: string;
  is_ready: boolean;
  reasons: string[];
  last_checked_at: string | null;
}

export function useAppSetupStatus() {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id;

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["app-setup-status", orgId],
    queryFn: async (): Promise<AppSetupStatusRow[]> => {
      if (!orgId) return [];
      // Schema: app_setup_status(status text, blocking_reasons jsonb, last_checked_at)
      // status in ('ready','not_ready','pending'). is_ready = (status='ready').
      const { data, error } = await (supabase as any)
        .from("app_setup_status")
        .select("app_id, status, blocking_reasons, last_checked_at")
        .eq("organization_id", orgId);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        app_id: r.app_id,
        is_ready: r.status === "ready",
        reasons: Array.isArray(r.blocking_reasons)
          ? r.blocking_reasons.filter((x: unknown) => typeof x === "string")
          : [],
        last_checked_at: r.last_checked_at ?? null,
      }));
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });

  const byApp = useMemo(() => {
    const m = new Map<string, AppSetupStatusRow>();
    for (const r of rows) m.set(r.app_id, r);
    return m;
  }, [rows]);

  return {
    isLoading,
    rows,
    /** Returns null if no row exists (treat as "no setup tracked → assume ready"). */
    getStatus: (appId: string): AppSetupStatusRow | null =>
      byApp.get(appId) ?? null,
    /** Convenience: { isReady, reasons } in the shape AppCard expects. */
    getCardSummary: (appId: string): { isReady: boolean; reasons: string[] } | null => {
      const row = byApp.get(appId);
      if (!row) return null;
      return { isReady: row.is_ready, reasons: row.reasons };
    },
  };
}
