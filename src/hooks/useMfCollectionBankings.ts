/**
 * Banking of daily collections (C14).
 *
 * A closed collection batch (the officer's cash + mobile-money receipts for a
 * meeting/day) is banked into an institution bank account through
 * `mf_bank_collection_batch`. The server totals the receipts, posts the journal
 * (bank debit / cash & mobile-money credit) and writes the matchable bank
 * deposit line. React only collects intent.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export interface MfCollectionBanking {
  id: string;
  batch_id: string;
  bank_account_id: string;
  banked_on: string;
  amount: number;
  cash_amount: number;
  mobile_money_amount: number;
  reference: string | null;
  notes: string | null;
  journal_entry_id: string | null;
  bank_transaction_id: string | null;
  created_at: string;
}

export interface MfBankableAccount {
  id: string;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  currency: string | null;
}


/** Bank accounts the institution can bank collections into. */
export function useMfBankAccounts() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-bankable-accounts", businessId],
    queryFn: async () => {
      if (!businessId) return [] as MfBankableAccount[];
      const { data, error } = await supabase
        .from("bank_accounts")
        .select("id,name,bank_name,account_number,currency")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MfBankableAccount[];
    },
    enabled: !!businessId,
  });

  return {
    bankAccounts: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

/** Collection bankings for the institution, plus the banking action. */
export function useMfCollectionBankings() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-collection-bankings", businessId],
    queryFn: async () => {
      if (!businessId) return [] as MfCollectionBanking[];
      const { data, error } = await supabase
        .from("mf_collection_bankings")
        .select(
          "id,batch_id,bank_account_id,banked_on,amount,cash_amount,mobile_money_amount,reference,notes,journal_entry_id,bank_transaction_id,created_at",
        )
        .eq("business_id", businessId)
        .order("banked_on", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as MfCollectionBanking[];
    },
    enabled: !!businessId,
  });

  const bankBatch = useMutation({
    mutationFn: async (input: {
      batchId: string;
      bankAccountId: string;
      bankedOn: string;
      reference?: string | null;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("mf_bank_collection_batch", {
        p_batch_id: input.batchId,
        p_bank_account_id: input.bankAccountId,
        p_banked_on: input.bankedOn,
        p_reference: input.reference ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-collection-bankings"] });
      queryClient.invalidateQueries({ queryKey: ["mf-repayment-batches"] });
      queryClient.invalidateQueries({ queryKey: ["bank-transactions"] });
      toast.success("Collections banked and posted");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The banking was refused")),
  });

  return {
    bankings: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    bankBatch,
  };
}
