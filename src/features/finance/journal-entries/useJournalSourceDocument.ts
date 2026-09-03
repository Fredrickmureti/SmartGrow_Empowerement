/**
 * useJournalSourceDocument — resolves a posted entry's `source_type` /
 * `source_id` into the business document that caused it, so an auditor can
 * walk from the ledger back to the transaction.
 *
 * A registry, not a special case: each resolver reads its own canonical table
 * under RLS and returns a label plus the record route. Entries whose source
 * kind has no resolver keep the plain source label they had before.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { JournalEntry } from "@/hooks/useJournalEntries";

export interface JournalSourceDocument {
  /** Human label for the originating document, e.g. "LC-2026-0004". */
  label: string;
  /** In-app route to that document's record page. */
  href: string;
  /** Kind-specific facts worth showing on the entry, already formatted upstream. */
  facts?: { label: string; amount: number }[];
}

type Resolver = (sourceId: string) => Promise<JournalSourceDocument | null>;

// Microfinance scope: no ERP document resolvers remain. Add lending document
// resolvers here as the posting surfaces land.
const RESOLVERS: Record<string, Resolver> = {};

export function useJournalSourceDocument(entry: JournalEntry | undefined) {
  const sourceType = entry?.source_type ?? null;
  const sourceId = (entry as { source_id?: string | null } | undefined)?.source_id ?? null;
  const resolver = sourceType ? RESOLVERS[sourceType] : undefined;

  const query = useQuery({
    queryKey: ["journal-source-document", sourceType, sourceId],
    enabled: !!resolver && !!sourceId,
    queryFn: () => resolver!(sourceId!),
  });

  return query.data ?? null;
}
