/**
 * Append-only change log for lending accounting mappings.
 *
 * Written by the `mf_account_mappings` audit trigger; this hook is read-only
 * and exists so Lending → Configuration → Accounting can show who rebound a
 * money-flow to a different ledger account, and when.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export interface MfMappingAuditRow {
  id: string;
  mapping_key: string;
  branch_id: string | null;
  old_account_id: string | null;
  new_account_id: string | null;
  action: string;
  changed_by: string | null;
  changed_by_name: string | null;
  notes: string | null;
  created_at: string;
}

export function useMfMappingAudit(limit = 25) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  return useQuery({
    queryKey: ["mf-mapping-audit", businessId, limit],
    enabled: !!businessId,
    queryFn: async (): Promise<MfMappingAuditRow[]> => {
      if (!businessId) return [];
      const { data, error } = await supabase
        .from("mf_account_mapping_audit")
        .select(
          "id,mapping_key,branch_id,old_account_id,new_account_id,action,changed_by,notes,created_at",
        )
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;

      const rows = (data ?? []) as Omit<MfMappingAuditRow, "changed_by_name">[];
      const actorIds = Array.from(
        new Set(rows.map((r) => r.changed_by).filter((v): v is string => !!v)),
      );

      let names = new Map<string, string>();
      if (actorIds.length > 0) {
        // profiles is keyed by user_id, never id.
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", actorIds);
        names = new Map(
          (profiles ?? []).map((p: any) => [p.user_id, p.full_name || p.email || ""]),
        );
      }

      return rows.map((r) => ({
        ...r,
        changed_by_name: r.changed_by ? names.get(r.changed_by) ?? null : null,
      }));
    },
  });
}
