import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface AvailableCredit {
  id: string;
  credit_note_number: string;
  total: number;
  amount_applied: number;
  available: number;
  issue_date: string;
  reason: string;
}

/**
 * Customer credit for a contact (ADR 0131).
 *
 * The spendable amount comes from `customer_credit_balances` — a GL-anchored
 * liability projection of `customer_credit_movements` — NOT from a derived
 * `total - amount_applied` on credit notes. The credit-note list is kept only
 * as the document-level provenance shown next to the balance.
 */
export function useCustomerCredits(contactId?: string | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data: credits = [], isLoading, refetch } = useQuery({
    queryKey: ["customer-credits", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<AvailableCredit[]> => {
      if (!contactId || !currentOrg?.id) return [];

      let query = supabase
        .from("credit_notes")
        .select("id, credit_note_number, total, amount_applied, issue_date, reason")
        .eq("organization_id", currentOrg.id)
        .eq("contact_id", contactId)
        .eq("status", "issued");

      query = query.eq("business_id", currentBusiness!.id);
      const { data, error } = await query.order("issue_date", { ascending: false });
      if (error) throw error;

      return (data || [])
        .map((cn) => ({
          id: cn.id,
          credit_note_number: cn.credit_note_number,
          total: cn.total,
          amount_applied: cn.amount_applied || 0,
          available: cn.total - (cn.amount_applied || 0),
          issue_date: cn.issue_date,
          reason: cn.reason,
        }))
        .filter((cn) => cn.available > 0);
    },
    enabled: !!contactId && !!currentOrg?.id,
  });

  const { data: balance = 0, refetch: refetchBalance } = useQuery({
    queryKey: ["customer-credit-balance", contactId, currentBusiness?.id],
    queryFn: async (): Promise<number> => {
      if (!contactId || !currentBusiness?.id) return 0;
      const { data, error } = await supabase
        .from("customer_credit_balances")
        .select("balance")
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId);
      if (error) throw error;
      return (data || []).reduce((sum, row: { balance: number | null }) => sum + Number(row.balance ?? 0), 0);
    },
    enabled: !!contactId && !!currentBusiness?.id,
  });

  const totalAvailableCredit = balance;

  return {
    credits,
    totalAvailableCredit,
    isLoading,
    refetch,
  };
}
