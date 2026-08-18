/**
 * useReconciliationSuggestions
 * 
 * Fetches server-side GL match suggestions for unreconciled bank transactions.
 * Uses the `get_reconciliation_match_suggestions` RPC which scores matches
 * based on amount, date proximity, and reference similarity.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface ReconciliationSuggestion {
  bank_transaction_id: string;
  bank_amount: number;
  bank_date: string;
  bank_description: string;
  journal_entry_id: string;
  entry_number: string;
  entry_date: string;
  je_description: string;
  source_type: string;
  source_id: string;
  gl_amount: number;
  match_score: number;
  line_id: string;
}

export function useReconciliationSuggestions(bankAccountId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["reconciliation-suggestions", currentOrg?.id, currentBusiness?.id, bankAccountId],
    queryFn: async (): Promise<ReconciliationSuggestion[]> => {
      if (!currentOrg?.id || !currentBusiness?.id || !bankAccountId) return [];

      const { data, error } = await supabase.rpc("get_reconciliation_match_suggestions", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _bank_account_id: bankAccountId,
        _limit: 50,
      });

      if (error) throw error;
      return (data as unknown as ReconciliationSuggestion[]) || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id && !!bankAccountId,
    staleTime: 30_000,
  });
}
