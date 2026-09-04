import { normalizeError } from "@/services/resilience";
/**
 * useJournalBooks — journal categorization for a microfinance institution.
 * Books are Bank, Cash and General only; lending money-flows (disbursements,
 * collections) are General books seeded with lending names. Each journal entry
 * carries a journal_book_id so reports can filter by source ledger.
 *
 * Backed by `public.journal_books`.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";

/**
 * Microfinance journal types. `sale` / `purchase` / `situation` were ERP-era
 * types and are no longer offered; legacy rows carrying them are deactivated
 * by `seedDefaults`.
 */
export type JournalType = "bank" | "cash" | "general";

/** The books a microfinance institution actually posts through. */
const MF_DEFAULT_BOOKS: Array<{
  code: string;
  name: string;
  journal_type: JournalType;
  description: string;
}> = [
  { code: "DSB", name: "Disbursements", journal_type: "general", description: "Loan disbursements to clients" },
  { code: "COL", name: "Collections", journal_type: "general", description: "Loan repayments collected from clients and groups" },
  { code: "BNK", name: "Bank", journal_type: "bank", description: "Bank movements, transfers and banking of collections" },
  { code: "CSH", name: "Cash", journal_type: "cash", description: "Branch cash movements" },
  { code: "MSC", name: "Miscellaneous", journal_type: "general", description: "Manual journals and adjustments" },
];

/** Journal types inherited from the ERP era — kept only to deactivate. */
const RETIRED_JOURNAL_TYPES = ["sale", "purchase", "situation"];


export interface JournalBook {
  id: string;
  organization_id: string;
  business_id: string;
  code: string;
  name: string;
  journal_type: JournalType;
  default_account_id: string | null;
  is_active: boolean;
  is_system: boolean;
  sequence_prefix: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export function useJournalBooks() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const [books, setBooks] = useState<JournalBook[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchBooks = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setBooks([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await (supabase as any)
      .from("journal_books")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("code");

    if (error) {
      console.error("Failed to load journal books", error);
      toast({
        title: "Failed to load journal books",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      setBooks([]);
    } else {
      setBooks((data ?? []) as JournalBook[]);
    }
    setIsLoading(false);
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  useEffect(() => {
    fetchBooks();
  }, [fetchBooks]);

  /** Seed the 5 standard journal books for the active business. */
  const seedDefaults = useCallback(async () => {
    if (!currentBusiness?.id) return;
    const { error } = await (supabase as any).rpc(
      "seed_default_journal_books",
      { _business_id: currentBusiness.id },
    );
    if (error) {
      toast({
        title: "Could not seed journal books",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Default journal books created" });
    await fetchBooks();
  }, [currentBusiness?.id, fetchBooks, toast]);

  const createBook = useCallback(
    async (book: {
      code: string;
      name: string;
      journal_type: JournalType;
      default_account_id?: string | null;
      sequence_prefix?: string | null;
      description?: string | null;
    }) => {
      if (!currentOrg?.id || !currentBusiness?.id) {
        throw new Error("Select a company first");
      }
      const { error } = await (supabase as any).from("journal_books").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        ...book,
      });
      if (error) throw error;
      await fetchBooks();
    },
    [currentOrg?.id, currentBusiness?.id, fetchBooks],
  );

  const updateBook = useCallback(
    async (id: string, updates: Partial<JournalBook>) => {
      const { error } = await (supabase as any)
        .from("journal_books")
        .update(updates)
        .eq("id", id);
      if (error) throw error;
      await fetchBooks();
    },
    [fetchBooks],
  );

  const deleteBook = useCallback(
    async (id: string) => {
      const { error } = await (supabase as any)
        .from("journal_books")
        .delete()
        .eq("id", id);
      if (error) throw error;
      await fetchBooks();
    },
    [fetchBooks],
  );

  return {
    books,
    isLoading,
    fetchBooks,
    seedDefaults,
    createBook,
    updateBook,
    deleteBook,
  };
}
