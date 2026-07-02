import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export interface OrphanJournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  source_type: string | null;
  source_id: string | null;
  total_debit: number;
  total_credit: number;
}

/**
 * Detects posted journal entries with null source_type/source_id,
 * which indicates orphaned entries not linked to any source document.
 */
export function useOrphanJEDetection() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["orphan-je-detection", currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<OrphanJournalEntry[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const { data, error } = await supabase
        .from("journal_entries")
        .select(`
          id, entry_number, entry_date, description,
          source_type, source_id,
          journal_entry_lines(debit, credit)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "posted")
        .is("source_type", null);

      if (error) throw error;

      return (data || []).map((je: any) => ({
        id: je.id,
        entry_number: je.entry_number,
        entry_date: je.entry_date,
        description: je.description,
        source_type: je.source_type,
        source_id: je.source_id,
        total_debit: (je.journal_entry_lines || []).reduce(
          (sum: number, l: any) => sum + (Number(l.debit) || 0), 0
        ),
        total_credit: (je.journal_entry_lines || []).reduce(
          (sum: number, l: any) => sum + (Number(l.credit) || 0), 0
        ),
      }));
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 60_000,
  });
}
