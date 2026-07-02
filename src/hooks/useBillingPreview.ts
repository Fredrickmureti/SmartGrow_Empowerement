/**
 * useBillingPreview — "what would my bill be if I switched to plan X?"
 *
 * Wraps `compute_org_billing_for_plan(org_id, plan_id, billing_cycle)`, the
 * preview-mode sibling of `compute_org_billing`. Same math, but lets the
 * Upgrade page show a real total per plan candidate without writing to
 * `organizations.subscription_plan_id`.
 *
 * Always prefer this over recomputing prices on the client. The server is
 * the only place that knows the truth about plan inclusions, trial windows,
 * per-user uplift, and currency.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import type { BillingCycle, OrgBilling } from "@/hooks/useOrgBilling";

export interface BillingPreview extends OrgBilling {
  preview: true;
}

export function useBillingPreview(planId: string | null | undefined, cycle: BillingCycle = "monthly") {
  const { currentOrg } = useSession();
  const orgId = currentOrg?.id;

  const query = useQuery<BillingPreview | null>({
    queryKey: ["org-billing-preview", orgId, planId, cycle],
    enabled: !!orgId && !!planId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!orgId || !planId) return null;
      const { data, error } = await (supabase as any).rpc("compute_org_billing_for_plan", {
        p_org_id: orgId,
        p_plan_id: planId,
        p_billing_cycle: cycle,
      });
      if (error) throw error;
      return (data ?? null) as BillingPreview | null;
    },
  });

  return {
    preview: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
