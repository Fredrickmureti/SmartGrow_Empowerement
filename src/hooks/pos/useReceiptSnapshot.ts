/**
 * Stage B — useReceiptSnapshot
 *
 * Reads the frozen receipt snapshot written by `_pos_write_receipt_snapshot`
 * AFTER INSERT trigger on `pos_transactions`. Reprint surfaces (preview,
 * PDF, email) MUST prefer this over live business / branch / receipt-settings
 * lookups so historical receipts stay byte-stable when those underlying
 * records change.
 *
 * Returns `null` when no snapshot exists (e.g. transactions older than the
 * Stage B migration). Callers fall back to live lookups in that case.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface POSReceiptSnapshot {
  schema_version: number;
  transaction: Record<string, any>;
  items: Array<Record<string, any>>;
  payments: Array<Record<string, any>>;
  business: Record<string, any> | null;
  branch: Record<string, any> | null;
  organization: Record<string, any> | null;
  customer: Record<string, any> | null;
  cashier: { id: string | null; name: string | null; email: string | null } | null;
  register: Record<string, any> | null;
  business_receipt_settings: Record<string, any> | null;
  register_receipt_settings: Record<string, any> | null;
}

export function useReceiptSnapshot(transactionId: string | null | undefined) {
  return useQuery({
    queryKey: ["pos-receipt-snapshot", transactionId],
    enabled: !!transactionId,
    staleTime: Infinity, // snapshots are immutable by design
    queryFn: async (): Promise<POSReceiptSnapshot | null> => {
      if (!transactionId) return null;
      const { data, error } = await supabase
        .from("pos_receipt_snapshots" as any)
        .select("payload")
        .eq("transaction_id", transactionId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return (data as any).payload as POSReceiptSnapshot;
    },
  });
}