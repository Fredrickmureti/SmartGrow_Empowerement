/**
 * usePurchaseReturnEvents — the append-only audit trail of one return.
 *
 * `purchase_return_events` is written only by the server commands, so this is
 * the honest history: who submitted, which governance mode decided, when stock
 * left, which debit note settled it. Read-only by construction.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface PurchaseReturnEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_user_id: string | null;
  governance_mode: string | null;
  approval_request_id: string | null;
  journal_entry_id: string | null;
  vendor_credit_note_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export function usePurchaseReturnEvents(purchaseReturnId: string | null | undefined) {
  const [events, setEvents] = useState<PurchaseReturnEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!purchaseReturnId) {
      setEvents([]);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("purchase_return_events")
      .select("*")
      .eq("purchase_return_id", purchaseReturnId)
      .order("created_at", { ascending: true });
    setEvents((data as unknown as PurchaseReturnEvent[]) ?? []);
    setLoading(false);
  }, [purchaseReturnId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { events, loading, refetch: load };
}
