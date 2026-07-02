/**
 * Resolves the register_id the operator currently has open in the POS
 * terminal so other surfaces (POS Settings → Send Test Print, Sales /
 * Purchases auto-thermal routing) can target the same hardware proxy
 * binding the cashier is actually printing through.
 *
 * Strategy: pick the most recent ACTIVE pos_session for the current
 * organization + business. Falls back to null when no till is open;
 * callers should then degrade to first-active register.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";

export function useActivePOSRegister() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ["pos-active-register-anywhere", orgId, bizId, branchId],
    queryFn: async (): Promise<string | null> => {
      if (!orgId || !bizId) return null;
      let query = supabase
        .from("pos_sessions")
        .select("register_id, started_at")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .eq("status", "active")
        .is("ended_at", null);
      // Stage B branch isolation: never resolve a foreign-branch till.
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) return null;
      return data?.[0]?.register_id ?? null;
    },
    enabled: !!orgId && !!bizId,
    // Refetch on window focus so a freshly opened till in another tab
    // surfaces here without a manual refresh.
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  return { activeRegisterId: data ?? null, isLoading };
}