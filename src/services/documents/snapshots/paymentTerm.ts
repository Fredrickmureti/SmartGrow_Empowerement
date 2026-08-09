/**
 * Phase 4 — structured payment term projection for document snapshots.
 *
 * A payment term is STRUCTURED commercial data (name + net days) and is
 * NOT the document's Terms & Conditions prose. Snapshots therefore carry
 * it in its own `payment_term` field; the free-text `terms` field stays
 * reserved for legal prose. Never collapse one into the other.
 *
 * Snapshots are frozen at submit time, so the term name/days are copied
 * in as values — renaming a payment term later must not rewrite history.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SnapshotPaymentTerm {
  id: string;
  name: string | null;
  days: number | null;
}

/**
 * Loads the term referenced by a document's `payment_term_id`.
 * Returns null when the document has no term (due on receipt) or the
 * term row is unreadable — printing must never fail over a label.
 */
export async function fetchPaymentTermSnapshot(
  supabase: SupabaseClient,
  paymentTermId: string | null | undefined,
): Promise<SnapshotPaymentTerm | null> {
  if (!paymentTermId) return null;
  const { data, error } = await supabase
    .from("payment_terms")
    .select("id, name, days")
    .eq("id", paymentTermId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String((data as { id: string }).id),
    name: (data as { name: string | null }).name ?? null,
    days: (data as { days: number | null }).days ?? null,
  };
}
