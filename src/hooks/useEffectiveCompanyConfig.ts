/**
 * useEffectiveCompanyConfig — React Query hook over the SQL resolver.
 *
 * Two call patterns:
 *
 *   1. Per-document (PREFERRED): pass the record's own business_id +
 *      branch_id. The result is stable regardless of the user's current
 *      selection — exactly what document rendering needs.
 *
 *      const { config } = useEffectiveCompanyConfig(invoice.business_id, invoice.branch_id);
 *
 *   2. Session default: omit both. The hook reads from the active
 *      business/branch via context. Use this only for forms that show
 *      the user "what would my receipt look like right now".
 */
import { useQuery } from "@tanstack/react-query";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import {
  getEffectiveCompanyConfig,
  type EffectiveCompanyConfig,
} from "@/lib/settings/getEffectiveCompanyConfig";

export function useEffectiveCompanyConfig(
  businessId?: string | null,
  branchId?: string | null,
) {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  // Per-document call: caller passed an explicit businessId.
  // Session-default call: fall back to context.
  const resolvedBusinessId = businessId ?? currentBusiness?.id ?? null;
  const resolvedBranchId =
    businessId !== undefined ? branchId ?? null : currentBranch?.id ?? null;

  const query = useQuery<EffectiveCompanyConfig | null>({
    queryKey: [
      "effective-company-config",
      resolvedBusinessId,
      resolvedBranchId,
    ],
    enabled: !!resolvedBusinessId,
    staleTime: 5 * 60 * 1000, // 5 min — invalidated by branch/business mutations
    queryFn: () =>
      getEffectiveCompanyConfig(resolvedBusinessId!, resolvedBranchId),
  });

  return {
    config: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
