/**
 * Internal members of an organization (workspace users, NOT portal users).
 *
 * Sourced from `user_business_access` (which only lists workspace seats —
 * portal/customer/vendor contacts never appear here), joined to `profiles`
 * for the human-readable name/email and to `user_roles` for the highest
 * role badge per user.
 *
 * Returns a deduplicated list ready to feed the Self-Action override
 * pickers — no UUID typing required anywhere in the UI.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface OrgInternalUser {
  user_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  primary_role: string;
}

const ROLE_RANK: Record<string, number> = {
  super_admin: 100,
  owner: 90,
  admin: 80,
  accountant: 70,
  manager: 60,
  staff: 50,
  user: 10,
};

function pickPrimaryRole(roles: string[]): string {
  if (roles.length === 0) return "user";
  return [...roles].sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0];
}

export function useOrgInternalUsers(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ["org-internal-users", organizationId],
    enabled: !!organizationId,
    staleTime: 60_000,
    queryFn: async (): Promise<OrgInternalUser[]> => {
      // 1. Workspace seats for this org. user_business_access is the
      //    canonical "internal member" list — portal users never land here.
      const { data: access, error: accessErr } = await supabase
        .from("user_business_access")
        .select("user_id, role")
        .eq("organization_id", organizationId!);
      if (accessErr) throw accessErr;

      const userIds = Array.from(new Set((access ?? []).map((r) => r.user_id)));
      if (userIds.length === 0) return [];

      // 2. Profile data — name + email.
      const { data: profiles, error: profileErr } = await supabase
        .from("profiles")
        .select("user_id, full_name, email, avatar_url")
        .in("user_id", userIds);
      if (profileErr) throw profileErr;

      // 3. Highest role per user (org-scoped first, then global fallback
      //    via user_business_access.role).
      const { data: orgRoles, error: roleErr } = await supabase
        .from("user_roles")
        .select("user_id, role, is_active")
        .eq("organization_id", organizationId!)
        .in("user_id", userIds);
      if (roleErr) throw roleErr;

      const rolesByUser = new Map<string, string[]>();
      (orgRoles ?? []).forEach((r) => {
        if (r.is_active === false) return;
        const list = rolesByUser.get(r.user_id) ?? [];
        list.push(r.role);
        rolesByUser.set(r.user_id, list);
      });
      // Fall back to user_business_access.role when user_roles has nothing.
      (access ?? []).forEach((r) => {
        if (!rolesByUser.has(r.user_id) && r.role) {
          rolesByUser.set(r.user_id, [r.role]);
        }
      });

      const byId = new Map<string, OrgInternalUser>();
      (profiles ?? []).forEach((p) => {
        byId.set(p.user_id, {
          user_id: p.user_id,
          full_name: p.full_name?.trim() || p.email || "Unnamed user",
          email: p.email || "",
          avatar_url: p.avatar_url ?? null,
          primary_role: pickPrimaryRole(rolesByUser.get(p.user_id) ?? []),
        });
      });

      return Array.from(byId.values()).sort((a, b) =>
        a.full_name.localeCompare(b.full_name),
      );
    },
  });
}
