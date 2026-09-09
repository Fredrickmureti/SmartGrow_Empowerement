/**
 * The single active group a client belongs to, if any.
 *
 * One active membership per client is enforced in the database by the
 * `mf_group_members_limit` trigger, so this read returns at most one row. Read
 * only — membership is created and ended through the authoritative group paths.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MfClientActiveGroup {
  id: string;
  group_number: string;
  name: string;
  branch_id: string;
  loan_officer_id: string | null;
}

export function useMfClientActiveGroup(clientId: string | null) {
  const query = useQuery({
    queryKey: ["mf-client-active-group", clientId],
    enabled: !!clientId,
    queryFn: async (): Promise<MfClientActiveGroup | null> => {
      if (!clientId) return null;
      const { data, error } = await supabase
        .from("mf_group_members")
        .select("group:mf_groups(id,group_number,name,branch_id,loan_officer_id)")
        .eq("client_id", clientId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const group = (data as { group: MfClientActiveGroup | null } | null)?.group;
      return group ?? null;
    },
  });

  return {
    group: query.data ?? null,
    isLoading: query.isLoading,
  };
}
