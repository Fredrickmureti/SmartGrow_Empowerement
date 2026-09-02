/**
 * Microfinance accounting mappings (C2).
 *
 * Every lending money-flow resolves to a ledger account through this
 * configuration table. Domain code never names an account UUID.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";

export type MfMappingKey =
  | "principal_receivable"
  | "interest_income"
  | "interest_receivable"
  | "fee_income"
  | "penalty_income"
  | "cash"
  | "bank"
  | "mobile_money"
  | "write_off_expense"
  | "loan_loss_provision"
  | "suspended_interest";

export interface MfMappingSpec {
  key: MfMappingKey;
  label: string;
  description: string;
  accountType: "asset" | "liability" | "equity" | "income" | "expense";
}

export const MF_MAPPING_SPECS: MfMappingSpec[] = [
  { key: "principal_receivable", label: "Loan principal receivable", description: "Outstanding principal owed by clients.", accountType: "asset" },
  { key: "interest_receivable", label: "Interest receivable", description: "Accrued, unpaid interest.", accountType: "asset" },
  { key: "interest_income", label: "Interest income", description: "Interest earned on loans.", accountType: "income" },
  { key: "fee_income", label: "Fee income", description: "Processing and other loan fees.", accountType: "income" },
  { key: "penalty_income", label: "Penalty income", description: "Late-payment penalties.", accountType: "income" },
  { key: "cash", label: "Cash", description: "Cash collected or disbursed at the branch.", accountType: "asset" },
  { key: "bank", label: "Bank", description: "Bank account used for disbursement and banking.", accountType: "asset" },
  { key: "mobile_money", label: "Mobile money", description: "Mobile money float account.", accountType: "asset" },
  { key: "write_off_expense", label: "Write-off expense", description: "Loans written off.", accountType: "expense" },
  { key: "loan_loss_provision", label: "Loan loss provision", description: "Provision against expected losses.", accountType: "liability" },
  { key: "suspended_interest", label: "Suspended interest", description: "Interest suspended on non-performing loans.", accountType: "liability" },
  { key: "client_advance", label: "Client advance / overpayment", description: "Client funds received beyond amounts due, held as a liability.", accountType: "liability" },
];

export interface MfAccountMapping {
  id: string;
  business_id: string;
  branch_id: string | null;
  mapping_key: MfMappingKey;
  account_id: string;
  notes: string | null;
}

export function useMfAccountMappings(branchId: string | null = null) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-account-mappings", businessId, branchId],
    queryFn: async () => {
      if (!businessId) return [] as MfAccountMapping[];
      const { data, error } = await supabase
        .from("mf_account_mappings")
        .select("id,business_id,branch_id,mapping_key,account_id,notes")
        .eq("business_id", businessId);
      if (error) throw error;
      return (data ?? []) as MfAccountMapping[];
    },
    enabled: !!businessId,
  });

  const byKey = new Map<string, MfAccountMapping>();
  for (const row of query.data ?? []) {
    // Branch override wins over the institution-wide default.
    const existing = byKey.get(row.mapping_key);
    if (row.branch_id === branchId || (!existing && row.branch_id === null)) {
      byKey.set(row.mapping_key, row);
    }
  }

  const setMapping = useMutation({
    mutationFn: async (input: { key: MfMappingKey; accountId: string }) => {
      if (!businessId) throw new Error("No institution selected");
      const existing = (query.data ?? []).find(
        (r) => r.mapping_key === input.key && r.branch_id === branchId,
      );
      if (existing) {
        const { error } = await supabase
          .from("mf_account_mappings")
          .update({ account_id: input.accountId })
          .eq("id", existing.id);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("mf_account_mappings").insert({
        business_id: businessId,
        branch_id: branchId,
        mapping_key: input.key,
        account_id: input.accountId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-account-mappings"] });
      toast.success("Mapping saved");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Could not save the mapping");
    },
  });

  return {
    mappings: query.data ?? [],
    resolved: byKey,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    setMapping,
    businessId,
  };
}
