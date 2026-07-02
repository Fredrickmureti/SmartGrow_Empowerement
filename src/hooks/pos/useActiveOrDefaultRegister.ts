/**
 * Returns the POS register the operator currently has open as a till; if
 * none, falls back to the first active register for the current business.
 *
 * Why: non-POS surfaces (Sales / Purchases / Finance print previews) need
 * to bind their HardwareProxy to *some* register so registered hardware
 * (receipt printers, drawers) actually loads + connects even when no till
 * session is open. Without this fallback, the Print button on those pages
 * silently degrades to "browser PDF" because no devices are bound.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { useActivePOSRegister } from "@/hooks/pos/useActivePOSRegister";

export function useActiveOrDefaultRegister() {
  const { activeRegisterId, isLoading: activeLoading } = useActivePOSRegister();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: defaultRegisterId, isLoading: defaultLoading } = useQuery({
    queryKey: ["pos-default-register", orgId, bizId, branchId],
    queryFn: async (): Promise<string | null> => {
      if (!orgId || !bizId) return null;
      let query = supabase
        .from("pos_registers")
        .select("id, created_at")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .eq("is_active", true);
      // Stage B: default register must belong to the active branch when one is set.
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) return null;
      return data?.[0]?.id ?? null;
    },
    enabled: !!orgId && !!bizId && !activeRegisterId,
    staleTime: 60_000,
  });

  return {
    registerId: activeRegisterId ?? defaultRegisterId ?? null,
    isLoading: activeLoading || defaultLoading,
    source: activeRegisterId ? ("active" as const) : defaultRegisterId ? ("default" as const) : ("none" as const),
  };
}
