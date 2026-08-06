/**
 * React-Query wrappers over the canonical AR / AP open-item summaries.
 * Every finance KPI surface reads receivables/payables through these hooks so
 * the dashboard and the AR/AP workspaces cannot diverge.
 */
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import {
  fetchARSummary,
  fetchAPSummary,
  EMPTY_OPEN_ITEMS_SUMMARY,
  type OpenItemsSummary,
} from "@/services/finance/openItems";

export function arSummaryKey(orgId: string, businessId: string | null, branchId: string | null) {
  return ["ar-summary", orgId, businessId, branchId] as const;
}

export function apSummaryKey(orgId: string, businessId: string | null, branchId: string | null) {
  return ["ap-summary", orgId, businessId, branchId] as const;
}

function useScopeIds() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { branchId } = useFinanceScope();
  return {
    orgId: currentOrg?.id || "",
    businessId: currentBusiness?.id || null,
    branchId: branchId || null,
  };
}

export function useARSummary(): { summary: OpenItemsSummary; isLoading: boolean } {
  const { orgId, businessId, branchId } = useScopeIds();
  const { data, isLoading } = useQuery({
    queryKey: arSummaryKey(orgId, businessId, branchId),
    queryFn: () => fetchARSummary(orgId, businessId, branchId),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  return { summary: data ?? EMPTY_OPEN_ITEMS_SUMMARY, isLoading };
}

export function useAPSummary(): { summary: OpenItemsSummary; isLoading: boolean } {
  const { orgId, businessId, branchId } = useScopeIds();
  const { data, isLoading } = useQuery({
    queryKey: apSummaryKey(orgId, businessId, branchId),
    queryFn: () => fetchAPSummary(orgId, businessId, branchId),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  return { summary: data ?? EMPTY_OPEN_ITEMS_SUMMARY, isLoading };
}
