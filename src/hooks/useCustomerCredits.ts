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
 * Hook to get available (unapplied) credits for a specific customer.
 * Queries credit_notes with status = 'issued' and amount_applied < total.
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

  const totalAvailableCredit = credits.reduce((sum, c) => sum + c.available, 0);

  return {
    credits,
    totalAvailableCredit,
    isLoading,
    refetch,
  };
}
