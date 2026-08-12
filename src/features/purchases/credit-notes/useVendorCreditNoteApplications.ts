/**
 * useVendorCreditNoteApplications — the settlement history of one vendor
 * credit note (ADR 0132 Phase 7).
 *
 * A credit note's `amount_applied` is a projection; the truth is the set of
 * application rows written by `apply_vendor_credit_to_bill_atomic` and undone
 * by `unapply_vendor_credit_from_bill_atomic`. This read exposes that ledger
 * so the record page can show *which* bills a credit settled, and let an
 * operator hand a specific application back.
 *
 * Read-only: every mutation goes through the server RPCs on
 * `useVendorCreditNotes`.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface VendorCreditApplication {
  id: string;
  credit_note_id: string;
  bill_id: string;
  amount: number;
  applied_at: string;
  notes: string | null;
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  bill?: { bill_number: string | null } | null;
}

export function useVendorCreditNoteApplications(creditNoteId: string | null | undefined) {
  const [applications, setApplications] = useState<VendorCreditApplication[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!creditNoteId) {
      setApplications([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("vendor_credit_note_applications")
      .select(
        "id, credit_note_id, bill_id, amount, applied_at, notes, journal_entry_id, reversal_journal_entry_id, reversed_at, reversal_reason, bill:bills(bill_number)" as string,
      )
      .eq("credit_note_id", creditNoteId)
      .order("applied_at", { ascending: false });
    if (!error) setApplications((data ?? []) as unknown as VendorCreditApplication[]);
    setLoading(false);
  }, [creditNoteId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { applications, loading, refetch: load };
}
