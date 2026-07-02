import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface AccountRoleEligibilityRow {
  role_key: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  detail_type: string;
  priority: number;
}

export interface SystemAccountRoleRow {
  role_key: string;
  label: string;
  description: string | null;
  required_account_type: "asset" | "liability" | "equity" | "income" | "expense";
  is_mandatory: boolean;
  category: string;
  sort_order: number;
}

/**
 * Fetch the eligibility model that drives the intelligent default-account
 * mapping engine. Cached for 10 minutes — these tables are effectively
 * static at runtime (only seeded by migrations).
 */
export function useAccountRoleEligibility() {
  return useQuery({
    queryKey: ["account-role-eligibility"],
    queryFn: async () => {
      const [rolesRes, eligRes] = await Promise.all([
        supabase.from("system_account_roles").select("*"),
        supabase.from("account_role_eligibility").select("*"),
      ]);
      if (rolesRes.error) throw rolesRes.error;
      if (eligRes.error) throw eligRes.error;

      const roles = (rolesRes.data ?? []) as SystemAccountRoleRow[];
      const eligibility = (eligRes.data ?? []) as AccountRoleEligibilityRow[];

      const eligibilityByRole = new Map<string, AccountRoleEligibilityRow[]>();
      for (const row of eligibility) {
        const list = eligibilityByRole.get(row.role_key) ?? [];
        list.push(row);
        eligibilityByRole.set(row.role_key, list);
      }
      // Stable sort by priority for deterministic UI rendering.
      eligibilityByRole.forEach((list) =>
        list.sort((a, b) => a.priority - b.priority),
      );

      const rolesByKey = new Map<string, SystemAccountRoleRow>();
      for (const r of roles) rolesByKey.set(r.role_key, r);

      return { roles, eligibility, eligibilityByRole, rolesByKey };
    },
    staleTime: 10 * 60 * 1000,
  });
}