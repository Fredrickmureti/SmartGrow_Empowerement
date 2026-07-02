/**
 * Journal Entries Provider
 *
 * Searches `journal_entries` by entry_number / reference / description.
 * RLS enforces org scope. Gated by `viewFinancials`.
 */

import { BookOpen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { CommandEntry } from "../types";
import type { CommandProvider, ProviderContext } from "./types";

async function fetchJournalEntries(
  query: string,
  ctx: ProviderContext,
): Promise<CommandEntry[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { data, error } = await supabase
    .from("journal_entries")
    .select("id, entry_number, reference, description, entry_date")
    .or(
      `entry_number.ilike.${pattern},reference.ilike.${pattern},description.ilike.${pattern}`,
    )
    .order("entry_date", { ascending: false })
    .limit(8)
    .abortSignal(ctx.signal);

  if (error || !data) return [];

  return data.map((j) => ({
    id: `record:journal:${j.id}`,
    kind: "record" as const,
    title: `JE ${j.entry_number}`,
    subtitle: [j.reference, j.description].filter(Boolean).join(" · ") || "Journal entry",
    appId: "finance",
    icon: BookOpen,
    keywords: [
      j.entry_number.toLowerCase(),
      (j.reference ?? "").toLowerCase(),
      (j.description ?? "").toLowerCase().slice(0, 80),
    ].filter(Boolean),
    weight: 45,
    to: `/finance/journal-entries?selected=${j.id}`,
  }));
}

export const journalEntriesProvider: CommandProvider = {
  id: "records:journal-entries",
  label: "Journal Entries",
  minQueryLength: 2,
  debounceMs: 200,
  limit: 8,
  fetch: fetchJournalEntries,
  permission: "viewFinancials",
};
