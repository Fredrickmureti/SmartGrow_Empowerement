/**
 * useGoodsReceiptsForOrder — the receipts a purchase order produced.
 *
 * Read-only. Receiving is captured in the WMS session (GRN convergence) and
 * reversal belongs to `void_goods_receipt_atomic` (ADR 0128); this hook exists
 * only so the purchase order record can *show* its receipts and offer the
 * reversal entry point, which previously had no operator surface at all.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface OrderGoodsReceipt {
  id: string;
  receipt_number: string;
  receipt_date: string;
  status: string;
  notes: string | null;
}

export function useGoodsReceiptsForOrder(purchaseOrderId: string | null | undefined) {
  const [receipts, setReceipts] = useState<OrderGoodsReceipt[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!purchaseOrderId) {
      setReceipts([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("goods_receipts")
      .select("id, receipt_number, receipt_date, status, notes")
      .eq("purchase_order_id", purchaseOrderId)
      .order("receipt_date", { ascending: false });
    if (!error) setReceipts((data ?? []) as OrderGoodsReceipt[]);
    setLoading(false);
  }, [purchaseOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { receipts, loading, refetch: load };
}
