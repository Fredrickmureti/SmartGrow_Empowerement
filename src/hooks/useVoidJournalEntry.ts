/**
 * Canonical void/reversal helper.
 *
 * Wraps the `void_journal_entry_atomic` RPC so every void path in the app
 * uses the SAME server-side function. The RPC:
 *   - Creates a reversal sub-entry (source_subtype='reversal') linked to the
 *     original document's source_type/source_id.
 *   - Flips dr/cr on every line and reverses account balance impact.
 *   - Marks the original entry status='reversed' and links reversed_by_id.
 *   - Is idempotent — calling it twice for the same JE returns the existing
 *     reversal id, never creates a duplicate.
 *
 * Use this everywhere instead of `.from("journal_entries").update({status:'voided'})`.
 */
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export function useVoidJournalEntry() {
  const { user } = useAuth();

  /**
   * Reverse a posted journal entry atomically.
   * Returns the id of the reversal JE.
   *
   * @param journalEntryId - the original JE to reverse
   * @param reason - audit reason captured on both original and reversal
   * @param reversalDate - optional date for the reversal entry (defaults to today)
   */
  const voidJournalEntry = async (
    journalEntryId: string,
    reason: string,
    reversalDate?: string,
  ): Promise<string> => {
    if (!journalEntryId) throw new Error("journalEntryId is required");

    const { data, error } = await supabase.rpc("void_journal_entry_atomic", {
      _entry_id: journalEntryId,
      _reason: reason,
      _user_id: user?.id ?? null,
      _entry_number: null,
      _reversal_date: reversalDate ?? null,
    } as any);

    if (error) throw error;
    return data as string;
  };

  return { voidJournalEntry };
}
