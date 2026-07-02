import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Derives account balances from posted journal entry lines via the
 * `get_account_balances` RPC — the single source of truth.
 *
 * Returns a Map<account_id, je_balance> for efficient lookup.
 */
export function useAccountBalances() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const query = useQuery({
    queryKey: queryKeys.accountBalances.rpc(currentOrg?.id || "", currentBusiness?.id),
    queryFn: async () => {
      if (!currentOrg?.id) return new Map<string, number>();

      const { data, error } = await supabase.rpc("get_account_balances", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness?.id || null,
      });

      if (error) throw error;

      const map = new Map<string, number>();
      for (const row of data || []) {
        map.set(row.account_id, Number(row.net_balance) || 0);
      }
      return map;
    },
    enabled: !!currentOrg?.id,
    staleTime: 10_000, // 10s — balances don't change every second
  });

  /** Get the ledger-derived balance for an account (opening_balance + JE movements) */
  const getEffectiveBalance = (accountId: string, openingBalance: number) => {
    const jeBalance = query.data?.get(accountId) ?? 0;
    return openingBalance + jeBalance;
  };

  return {
    balancesMap: query.data ?? new Map<string, number>(),
    isLoading: query.isLoading,
    refetch: query.refetch,
    getEffectiveBalance,
  };
}
