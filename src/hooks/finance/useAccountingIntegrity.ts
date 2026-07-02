import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export type AccountingIntegritySeverity = "critical" | "warning" | "info";

export interface AccountingIntegrityFinding {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  severity: AccountingIntegritySeverity;
  finding_code: string;
  finding_title: string;
  finding_detail: string;
  entity_type: string;
  entity_id: string;
  entity_ref: string | null;
  evidence: Record<string, unknown> | null;
  detected_at: string;
}

export function useAccountingIntegrity(limit = 200) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  return useQuery({
    queryKey: [
      "accounting-integrity-findings",
      currentOrg?.id,
      currentBusiness?.id ?? "all",
      currentBranch?.id ?? "all",
      limit,
    ],
    queryFn: async (): Promise<AccountingIntegrityFinding[]> => {
      if (!currentOrg?.id) return [];

      const { data, error } = await (supabase as any).rpc(
        "get_accounting_integrity_findings",
        { _include_supplemental: true },
      );

      if (error) throw error;
      return ((data ?? []) as AccountingIntegrityFinding[])
        .filter((finding) => finding.organization_id === currentOrg.id)
        .filter((finding) => !currentBusiness?.id || finding.business_id === currentBusiness.id)
        .filter((finding) => !currentBranch?.id || finding.branch_id === currentBranch.id)
        .slice(0, limit);
    },
    enabled: !!currentOrg?.id,
    staleTime: 60_000,
  });
}
