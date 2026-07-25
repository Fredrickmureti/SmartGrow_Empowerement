/**
 * Phase 1 — canonical read of the governance_action_registry table.
 *
 * This is the single source of truth for approval/governance action keys
 * across the app. Modules must NOT hard-code action strings; they either
 * consume this hook (UI) or reference `governance_action_registry` via
 * FK / trigger (DB). The static `SELF_ACTION_CATALOGUE` in
 * `src/lib/governance/selfActionCatalogue.ts` is a compile-time mirror
 * of this table (parity enforced by
 * `src/test/architecture/governance-action-registry-parity.test.ts`).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface GovernanceActionRegistryEntry {
  action_key: string;
  module: string;
  subject_table: string | null;
  subject_mode: "actor" | "from_entity";
  label: string;
  description: string;
  severity_default: "low" | "standard" | "high" | "critical";
  is_active: boolean;
}

export function useGovernanceActionRegistry(opts?: { activeOnly?: boolean }) {
  const activeOnly = opts?.activeOnly ?? true;
  return useQuery({
    queryKey: ["governance_action_registry", { activeOnly }],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<GovernanceActionRegistryEntry[]> => {
      let q = supabase
        .from("governance_action_registry" as never)
        .select(
          "action_key, module, subject_table, subject_mode, label, description, severity_default, is_active"
        )
        .order("module", { ascending: true })
        .order("action_key", { ascending: true });
      if (activeOnly) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as GovernanceActionRegistryEntry[];
    },
  });
}
