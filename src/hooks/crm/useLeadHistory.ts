/**
 * Read-only access to the authoritative CRM lead lifecycle log.
 *
 * `crm_lead_history` is written exclusively by the database trigger
 * `_crm_lead_history_record` and is immutable — there is deliberately no
 * mutation path here.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type LeadHistoryEntry = Database["public"]["Tables"]["crm_lead_history"]["Row"];

export function useLeadHistory(leadId: string | null | undefined, enabled = true) {
  const query = useQuery({
    queryKey: ["crm-lead-history", leadId],
    enabled: Boolean(leadId) && enabled,
    queryFn: async (): Promise<LeadHistoryEntry[]> => {
      const { data, error } = await supabase
        .from("crm_lead_history")
        .select("*")
        .eq("lead_id", leadId as string)
        .order("occurred_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as LeadHistoryEntry[];
    },
  });

  return {
    history: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
