/**
 * Per-employee setup-health (Wave G F2).
 *
 * Reads `public.v_employee_setup_health` (security-invoker view) so an
 * HR manager can see which employees are payroll-ready, which need
 * attention, and which are blocked — without opening every profile.
 *
 * Returned as a `Map<employee_id, Verdict>` for O(1) lookups in the
 * directory list/table renderers.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export type SetupVerdict = "ready" | "incomplete" | "blocked" | "inactive";

export interface SetupHealthRow {
  employee_id: string;
  has_active_employment: boolean;
  has_active_contract: boolean;
  open_blocking_findings: number;
  open_warn_findings: number;
  verdict: SetupVerdict;
}

export function useEmployeeSetupHealth() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [byId, setById] = useState<Map<string, SetupHealthRow>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!currentOrg?.id || !currentBusiness?.id) {
        setById(new Map());
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      const { data, error } = await supabase
        .from("v_employee_setup_health" as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .range(0, 4999);
      if (cancelled) return;
      if (error) {
        // Non-fatal: directory still renders, just without pills.
        console.warn("useEmployeeSetupHealth: load failed", error);
        setById(new Map());
      } else {
        const m = new Map<string, SetupHealthRow>();
        for (const row of (data || []) as any[]) {
          m.set(row.employee_id, row as SetupHealthRow);
        }
        setById(m);
      }
      setIsLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, currentBusiness?.id]);

  return { byId, isLoading };
}
