/**
 * useMyDraftCount — count of draft employee records owned by the current user
 * in the active org+business. Powers the "My drafts" badge in the user menu.
 *
 * Cached for 60s; the sidebar item polls cheaply and stays responsive when a
 * user creates or promotes a draft.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";

export function useMyDraftCount() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ["my-draft-count", currentOrg?.id, currentBusiness?.id, user?.id],
    enabled: Boolean(currentOrg?.id && currentBusiness?.id && user?.id),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "count_my_employee_drafts" as any,
        {
          p_org_id: currentOrg!.id,
          p_business_id: currentBusiness!.id,
        },
      );
      if (error) throw error;
      return (data as unknown as number) ?? 0;
    },
  });

  return { count: query.data ?? 0, isLoading: query.isLoading, refetch: query.refetch };
}
