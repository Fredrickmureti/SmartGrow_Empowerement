/**
 * Staff who may own clients, with the branches they are assigned to.
 *
 * The authoritative mapping is `user_branch_assignments` (user, business,
 * branch). A member of the organisation with no assignment cannot be a client's
 * loan officer — `mf_register_client` refuses that combination server side, so
 * the picker must not offer it either.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";

export interface BranchOfficer {
  user_id: string;
  name: string;
  /** Branch ids this person is assigned to, in the current institution. */
  branchIds: string[];
}

export function useBranchOfficers() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["branch-officers", businessId],
    enabled: !!businessId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<BranchOfficer[]> => {
      if (!businessId) return [];

      const { data: rows, error } = await supabase
        .from("user_branch_assignments")
        .select("user_id, branch_id")
        .eq("business_id", businessId);
      if (error) throw error;

      const byUser = new Map<string, string[]>();
      for (const row of rows ?? []) {
        const list = byUser.get(row.user_id) ?? [];
        if (!list.includes(row.branch_id)) list.push(row.branch_id);
        byUser.set(row.user_id, list);
      }
      if (byUser.size === 0) return [];

      // Profiles are keyed by user_id, never by id.
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", [...byUser.keys()]);
      if (profileError) throw profileError;

      const names = new Map<string, string>();
      for (const p of profiles ?? []) {
        names.set(p.user_id, p.full_name || p.email || "Unnamed member");
      }

      return [...byUser.entries()]
        .map(([user_id, branchIds]) => ({
          user_id,
          name: names.get(user_id) ?? "Unnamed member",
          branchIds,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  return {
    officers: query.data ?? [],
    isLoading: query.isLoading,
  };
}
