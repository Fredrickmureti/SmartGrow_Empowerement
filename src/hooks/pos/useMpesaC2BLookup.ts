import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export interface UnmatchedC2B {
  id: string;
  trans_id: string;
  trans_amount: number;
  trans_time: string;
  msisdn: string | null;
  first_name: string | null;
  last_name: string | null;
  bill_ref_number: string | null;
}

interface SearchOptions {
  /** Filter to amount ± 0 by default. Pass null to disable. */
  amount?: number | null;
  /** Window in minutes for "recent" payments. */
  recentMinutes?: number;
  /** Free-text matches against trans_id (M-Pesa receipt code) and msisdn. */
  query?: string;
}

/**
 * Cashier-side lookup for unreconciled M-Pesa C2B (paybill/till) payments
 * and the corresponding `attach_c2b_to_pos_transaction` mutation.
 *
 * Mirrors Odoo's "pull" tender flow: customer paid out-of-band, cashier
 * pulls the receipt from the C2B feed and attaches it to the open sale.
 */
export function useMpesaC2BLookup() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;
  const orgId = (currentBusiness as any)?.organization_id ?? null;
  const { toast } = useToast();

  const [recent, setRecent] = useState<UnmatchedC2B[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAttaching, setIsAttaching] = useState(false);

  const refresh = useCallback(async (opts: SearchOptions = {}) => {
    if (!orgId) {
      setRecent([]);
      return;
    }
    setIsLoading(true);
    const since = new Date(Date.now() - (opts.recentMinutes ?? 60) * 60 * 1000).toISOString();
    let q = supabase
      .from("mpesa_c2b_transactions")
      .select("id, trans_id, trans_amount, trans_time, msisdn, first_name, last_name, bill_ref_number")
      .eq("organization_id", orgId)
      .eq("is_reconciled", false)
      .is("matched_pos_transaction_id", null)
      .is("matched_invoice_id", null)
      .gte("trans_time", since)
      .order("trans_time", { ascending: false })
      .limit(20);

    if (businessId) {
      q = q.or(`business_id.eq.${businessId},business_id.is.null`);
    }
    if (typeof opts.amount === "number") {
      q = q.eq("trans_amount", opts.amount);
    }
    if (opts.query && opts.query.trim()) {
      const term = opts.query.trim();
      q = q.or(`trans_id.ilike.%${term}%,msisdn.ilike.%${term}%,bill_ref_number.ilike.%${term}%`);
    }

    const { data, error } = await q;
    setIsLoading(false);
    if (error) {
      console.error("[useMpesaC2BLookup] fetch failed", error);
      setRecent([]);
      return;
    }
    setRecent((data ?? []) as UnmatchedC2B[]);
  }, [orgId, businessId]);

  // Live updates: any new C2B for this org bumps the list.
  useEffect(() => {
    if (!orgId) return;
    const ch = supabase
      .channel(`mpesa_c2b_unreconciled_${orgId}`)
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "mpesa_c2b_transactions", filter: `organization_id=eq.${orgId}` },
        () => { refresh(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [orgId, refresh]);

  const attach = useCallback(async (c2bId: string, posTransactionId: string) => {
    setIsAttaching(true);
    const { data, error } = await supabase.rpc("attach_c2b_to_pos_transaction" as any, {
      _c2b_id: c2bId,
      _pos_transaction_id: posTransactionId,
    });
    setIsAttaching(false);
    if (error) {
      toast({
        title: "Could not attach M-Pesa payment",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return null;
    }
    toast({ title: "M-Pesa payment attached", description: "The sale has been updated." });
    await refresh();
    return data;
  }, [toast, refresh]);

  return { recent, isLoading, isAttaching, refresh, attach };
}
