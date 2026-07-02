import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";

export interface OrgMember {
  user_id: string;
  full_name: string | null;
  email: string;
}

/**
 * Fetches all profiles that belong to the current organization (via user_roles).
 * Returns a Map of user_id → display name for quick lookups.
 */
export function useOrgMembers() {
  const { currentOrg } = useOrganization();
  const organizationId = currentOrg?.id;

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      // Get user_ids from user_roles for this org, then fetch their profiles
      const { data: roles, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("organization_id", organizationId);

      if (rolesError) throw rolesError;
      if (!roles || roles.length === 0) return [];

      const userIds = [...new Set(roles.map((r) => r.user_id))];

      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", userIds);

      if (profilesError) throw profilesError;

      return (profiles || []) as OrgMember[];
    },
    enabled: !!organizationId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Build a lookup map: user_id → display name
  const memberMap = new Map<string, string>();
  for (const m of members) {
    memberMap.set(m.user_id, m.full_name || m.email || "Unknown");
  }

  const getUserName = (userId: string | null | undefined): string => {
    if (!userId) return "—";
    return memberMap.get(userId) || "Unknown User";
  };

  return { members, memberMap, getUserName, isLoading };
}
