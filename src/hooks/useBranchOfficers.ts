/**
 * Team members who may own clients, with the branches they are assigned to.
 *
 * Every active internal member of the institution is offered, whatever their
 * job title: an owner or an administrator is routinely the loan officer of a
 * group or a client in a small institution.
 *
 * Two facts are returned per person:
 *  - `branchIds` — branches they are explicitly assigned to
 *    (`user_branch_assignments`);
 *  - `orgWide` — they hold owner / admin / super_admin in the organisation and
 *    may therefore own clients in any branch.
 *
 * This mirrors `mf_officer_may_own_branch` in the database, which accepts the
 * officer when they are assigned to the branch OR hold one of those roles, so
 * the picker never offers a combination the server would refuse.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";

/** Roles that carry authority over every branch of the institution. */
const ORG_WIDE_ROLES = new Set(["owner", "admin", "super_admin"]);

export interface BranchOfficer {
  user_id: string;
  name: string;
  /** Branch ids this person is assigned to, in the current institution. */
  branchIds: string[];
  /** True when their role gives them authority over every branch. */
  orgWide: boolean;
}

export function useBranchOfficers() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const organizationId = currentBusiness?.organization_id;

  const query = useQuery({
    queryKey: ["branch-officers", businessId, organizationId],
    enabled: !!businessId && !!organizationId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<BranchOfficer[]> => {
      if (!businessId || !organizationId) return [];

      // Active internal members of this institution. Portal / customer users
      // never appear here, and removed members are excluded.
      const { data: activeRoles, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .eq("user_type", "internal");
      if (rolesError) throw rolesError;

      const orgWide = new Map<string, boolean>();
      for (const r of activeRoles ?? []) {
        const wide = ORG_WIDE_ROLES.has(String(r.role));
        orgWide.set(r.user_id, (orgWide.get(r.user_id) ?? false) || wide);
      }
      if (orgWide.size === 0) return [];

      const { data: rows, error } = await supabase
        .from("user_branch_assignments")
        .select("user_id, branch_id")
        .eq("business_id", businessId);
      if (error) throw error;

      const byUser = new Map<string, string[]>();
      for (const row of rows ?? []) {
        if (!orgWide.has(row.user_id)) continue;
        const list = byUser.get(row.user_id) ?? [];
        if (!list.includes(row.branch_id)) list.push(row.branch_id);
        byUser.set(row.user_id, list);
      }

      // Profiles are keyed by user_id, never by id.
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", [...orgWide.keys()]);
      if (profileError) throw profileError;

      const names = new Map<string, string>();
      for (const p of profiles ?? []) {
        names.set(p.user_id, p.full_name || p.email || "Unnamed member");
      }

      return [...orgWide.entries()]
        .map(([user_id, wide]) => ({
          user_id,
          name: names.get(user_id) ?? "Unnamed member",
          branchIds: byUser.get(user_id) ?? [],
          orgWide: wide,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  return {
    officers: query.data ?? [],
    isLoading: query.isLoading,
  };
}
