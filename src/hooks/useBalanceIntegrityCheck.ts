import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface BalanceDrift {
  account_id: string;
  business_id: string | null;
  account_code: string;
  account_name: string;
  stored_balance: number;
  ledger_balance: number;
  drift: number;
}

/**
 * Calls the `check_balance_integrity` RPC to detect any drift between
 * `accounts.current_balance` and balances derived from posted journal lines.
 *
 * Scoped to the currently active business (Odoo-grade per-entity boundary).
 * If no business is active, falls back to org-wide check.
 */
export function useBalanceIntegrityCheck() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "balance-integrity-check",
      currentOrg?.id,
      currentBusiness?.id ?? "all",
    ],
    queryFn: async (): Promise<BalanceDrift[]> => {
      if (!currentOrg?.id) return [];

      const { data, error } = await supabase.rpc("check_balance_integrity", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness?.id ?? null,
      });

      if (error) throw error;

      return (data || []).map((row: any) => ({
        account_id: row.account_id,
        business_id: row.business_id ?? null,
        account_code: row.account_code,
        account_name: row.account_name,
        stored_balance: Number(row.stored_balance) || 0,
        ledger_balance: Number(row.ledger_balance) || 0,
        drift: Number(row.drift) || 0,
      }));
    },
    enabled: !!currentOrg?.id,
    staleTime: 60_000,
  });
}
