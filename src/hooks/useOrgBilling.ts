/**
 * useOrgBilling — canonical billing summary for an organization.
 *
 * Reads the server-side SQL function `compute_org_billing(p_org_id, p_billing_cycle)`,
 * which is the SINGLE source of truth for what an org owes.
 *
 *   total = plan_price (cycle-aware, +per-user uplift if defined)
 *         + Σ paid add-on apps (installed, not in plan, not on free trial)
 *
 * Trial apps cost 0 until the trial ends (Odoo-style add-on trials).
 * Plan-included apps cost 0.
 *
 * UI MUST consume this hook instead of recomputing prices from
 * `platform_subscription_plans` + `app_pricing_rules` directly — that path is
 * easy to get wrong (plan inclusions, trial windows, per-user uplift, currency)
 * and would diverge from the server's invoicing math.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";

export type BillingCycle = "monthly" | "yearly";

export interface BillingAddon {
  app_id: string;
  monthly_price: number;
  yearly_price: number;
  is_per_user: boolean;
  line_total: number;
}

export interface OrgBilling {
  org_id: string;
  plan_id: string | null;
  plan_name: string | null;
  billing_cycle: BillingCycle;
  currency: string;
  user_count: number;
  plan_price: number;
  addons: BillingAddon[];
  addons_total: number;
  total: number;
  computed_at: string;
}

export function useOrgBilling(cycle: BillingCycle = "monthly") {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id;

  const query = useQuery<OrgBilling | null>({
    queryKey: ["org-billing", orgId, cycle],
    enabled: !!orgId,
    staleTime: 60 * 1000, // 1 minute — invalidated by install/uninstall/plan change
    queryFn: async () => {
      if (!orgId) return null;
      const { data, error } = await (supabase as any).rpc("compute_org_billing", {
        p_org_id: orgId,
        p_billing_cycle: cycle,
      });
      if (error) throw error;
      return (data ?? null) as OrgBilling | null;
    },
  });

  return {
    billing: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
