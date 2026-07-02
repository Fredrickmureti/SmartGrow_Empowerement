/**
 * Wave H F6 — Server-side aggregates for the Employees directory header.
 *
 * Replaces the client-side reduce over a 5000-row fetch with a single
 * `get_employee_directory_stats` RPC call (SECURITY INVOKER, RLS-aware).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEmployeeDirectoryScope } from "./useEmployeeDirectoryScope";

export interface EmployeeDirectoryStats {
  total: number;
  active: number;
  inactive: number;
  drafts: number;
  needs_attention: number;
  monthly_payroll: number;
}

const ZERO: EmployeeDirectoryStats = {
  total: 0,
  active: 0,
  inactive: 0,
  drafts: 0,
  needs_attention: 0,
  monthly_payroll: 0,
};

export function useEmployeeDirectoryStats() {
  const { orgId, businessId, branchIds, branchIdsKey, isReady } =
    useEmployeeDirectoryScope();

  const query = useQuery({
    queryKey: [
      "employee-directory-stats",
      orgId,
      businessId,
      branchIdsKey,
    ],
    enabled: isReady,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "get_employee_directory_stats" as any,
        {
          p_org_id: orgId!,
          p_business_id: businessId!,
          p_branch_ids: branchIds,
        },
      );
      if (error) throw error;
      const row = (data as any) ?? {};
      return {
        total: Number(row.total ?? 0),
        active: Number(row.active ?? 0),
        inactive: Number(row.inactive ?? 0),
        drafts: Number(row.drafts ?? 0),
        needs_attention: Number(row.needs_attention ?? 0),
        monthly_payroll: Number(row.monthly_payroll ?? 0),
      } as EmployeeDirectoryStats;
    },
  });

  return {
    stats: query.data ?? ZERO,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

