import { normalizeError } from "@/services/resilience";
/**
 * useJournalBooks — Odoo-style journal categorization (Sales, Purchases,
 * Bank, Cash, Misc). Each journal entry can be tagged with a journal_book_id
 * so reports can filter by source ledger.
 *
 * Created by Phase 13 finance overhaul. Backed by `public.journal_books`.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";

export type JournalType =
  | "sale"
  | "purchase"
  | "bank"
  | "cash"
  | "general"
  | "situation";

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
