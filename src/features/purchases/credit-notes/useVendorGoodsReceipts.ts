/**
 * useVendorGoodsReceipts — receipts booked against a given supplier.
 *
 * Read-only lookup used by the vendor credit note forms so a
 * quantity/quality-driven credit can be attached to the receipt it disputes.
 * Goods receipts carry no vendor of their own; the supplier is the one on the
 * originating purchase order, so the filter is applied through that join.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface VendorGoodsReceipt {
  id: string;
  receipt_number: string;
  receipt_date: string;
  status: string;
  purchase_order_id: string | null;
}

export function useVendorGoodsReceipts(vendorId: string | null | undefined) {
  const [receipts, setReceipts] = useState<VendorGoodsReceipt[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!vendorId) {
      setReceipts([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("goods_receipts")
      .select(
        "id, receipt_number, receipt_date, status, purchase_order_id, purchase_order:purchase_orders!inner(vendor_id)" as string,
      )
      .eq("purchase_order.vendor_id", vendorId)
      .order("receipt_date", { ascending: false })
      .limit(100);
    if (!error) setReceipts((data ?? []) as unknown as VendorGoodsReceipt[]);
    setLoading(false);
  }, [vendorId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { receipts, loading, refetch: load };
}
