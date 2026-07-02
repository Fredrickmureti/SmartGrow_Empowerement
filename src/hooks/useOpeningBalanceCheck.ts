import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

interface OpeningBalanceCheck {
  debitNormalTotal: number;
  creditNormalTotal: number;
  imbalance: number;
  isBalanced: boolean;
}

export function useOpeningBalanceCheck() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["opening-balance-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<OpeningBalanceCheck> => {
      if (!currentOrg?.id || !currentBusiness?.id) {
        return { debitNormalTotal: 0, creditNormalTotal: 0, imbalance: 0, isBalanced: true };
      }

      const { data: accounts, error } = await supabase
        .from("accounts")
        .select("account_type, opening_balance")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true);

      if (error) throw error;

      let debitNormalTotal = 0;
      let creditNormalTotal = 0;

      for (const a of accounts || []) {
        const bal = a.opening_balance || 0;
        if (bal === 0) continue;
        const isDebit = ["asset", "expense"].includes(a.account_type);
        if (isDebit) {
          if (bal >= 0) debitNormalTotal += bal;
          else creditNormalTotal += Math.abs(bal);
        } else {
          if (bal >= 0) creditNormalTotal += bal;
          else debitNormalTotal += Math.abs(bal);
        }
      }

      const imbalance = Math.abs(debitNormalTotal - creditNormalTotal);
      return {
        debitNormalTotal,
        creditNormalTotal,
        imbalance,
        isBalanced: imbalance < 0.01,
      };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });
}
