/**
 * usePayrollMappingFindings — Wave-3 surface for the
 * `payroll_mapping_findings` view + `payroll_generate_reclassification_je` RPC.
 *
 * The view returns every mapped payroll setting_key whose target account
 * violates an accounting role rule (e.g. salary mapped to a Cost of Goods
 * Sold account, or a payable folded into generic Accounts Payable). Wave-3
 * makes the rules a true database invariant via a BEFORE-trigger on
 * `default_account_settings`, but legacy mappings created before the trigger
 * still need to be surfaced and fixed. Same for already-posted JEs whose
 * lines hit role-violating accounts — those are repaired by posting a
 * reclassification JE.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { normalizeError } from "@/services/resilience";
import { toast } from "sonner";

export interface PayrollMappingFinding {
  setting_key: string;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  violation_code: string;
  severity: "critical" | "warning" | string;
  finding_detail: string;
  organization_id: string;
  business_id: string | null;
}

export function usePayrollMappingFindings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const queryKey = ["payroll-mapping-findings", currentOrg?.id, currentBusiness?.id];

  const query = useQuery({
    queryKey,
    enabled: !!currentOrg?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<PayrollMappingFinding[]> => {
      let q = (supabase as any)
        .from("payroll_mapping_findings")
        .select("*")
        .eq("organization_id", currentOrg!.id);
      if (currentBusiness?.id) {
        q = q.or(`business_id.is.null,business_id.eq.${currentBusiness.id}`);
      } else {
        q = q.is("business_id", null);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as PayrollMappingFinding[];
    },
  });

  const reclassify = useMutation({
    mutationFn: async (payroll_run_id: string) => {
      const { data, error } = await (supabase as any).rpc(
        "payroll_generate_reclassification_je",
        { p_run_id: payroll_run_id },
      );
      if (error) throw error;
      return data as string; // new JE id
    },
    onSuccess: () => {
      toast.success("Reclassification posted. COGS no longer carries payroll lines.");
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["trial-balance"] });
      qc.invalidateQueries({ queryKey: ["general-ledger"] });
    },
    onError: (err: any) => {
      toast.error(normalizeError(err).message || "Failed to post reclassification");
    },
  });

  const critical = (query.data || []).filter((f) => f.severity === "critical");
  const warning = (query.data || []).filter((f) => f.severity === "warning");

  return {
    rows: query.data || [],
    critical,
    warning,
    isLoading: query.isLoading,
    isError: query.isError,
    reclassify,
  };
}