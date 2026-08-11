/**
 * useReturnableReceipts — the source-document pick list for a purchase return.
 *
 * A goods return must originate from a goods receipt (the server refuses
 * otherwise): the receipt is what carries the landed cost, the lot/serial, the
 * packaging provenance and the warehouse the stock physically sits in. This
 * hook lists the company's receipts (with the supplier resolved through the
 * purchase order) and, for one selected receipt, the remaining-returnable
 * quantity per line from `purchase_return_returnable_lines`.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { applyBranchFilter } from "@/lib/branchScope";
import {
  fetchReturnableReceiptLines,
  type ReturnableReceiptLine,
} from "@/lib/purchases/purchaseReturnRpcs";

export interface ReturnableReceipt {
  id: string;
  receipt_number: string;
  receipt_date: string;
  status: string;
  warehouse_id: string | null;
  purchase_order_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  currency: string | null;
}

interface ReceiptRow {
  id: string;
  receipt_number: string;
  receipt_date: string;
  status: string;
  warehouse_id: string | null;
  purchase_order_id: string | null;
  purchase_order: {
    vendor_id: string | null;
    currency: string | null;
    vendor: { name: string | null } | null;
  } | null;
}

export function useReturnableReceipts(vendorId?: string | null) {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const [receipts, setReceipts] = useState<ReturnableReceipt[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!currentBusiness?.id) {
      setReceipts([]);
      return;
    }
    setLoading(true);
    let q = supabase
      .from("goods_receipts")
      .select(
        `id, receipt_number, receipt_date, status, warehouse_id, purchase_order_id,
         purchase_order:purchase_orders(vendor_id, currency, vendor:contacts(name))`,
      )
      .eq("business_id", currentBusiness.id)
      .order("receipt_date", { ascending: false })
      .limit(200);
    q = applyBranchFilter(q, currentBranch?.id ?? null);
    const { data, error } = await q;
    if (!error) {
      const mapped = ((data ?? []) as unknown as ReceiptRow[])
        .map<ReturnableReceipt>((r) => ({
          id: r.id,
          receipt_number: r.receipt_number,
          receipt_date: r.receipt_date,
          status: r.status,
          warehouse_id: r.warehouse_id,
          purchase_order_id: r.purchase_order_id,
          vendor_id: r.purchase_order?.vendor_id ?? null,
          vendor_name: r.purchase_order?.vendor?.name ?? null,
          currency: r.purchase_order?.currency ?? null,
        }))
        .filter((r) => (vendorId ? r.vendor_id === vendorId : true));
      setReceipts(mapped);
    }
    setLoading(false);
  }, [currentBusiness?.id, currentBranch?.id, vendorId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { receipts, loading, refetch: load };
}

export function useReturnableReceiptLines(goodsReceiptId: string | null | undefined) {
  const [lines, setLines] = useState<ReturnableReceiptLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!goodsReceiptId) {
      setLines([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setLines(await fetchReturnableReceiptLines(goodsReceiptId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load receipt lines");
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [goodsReceiptId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { lines, loading, error, refetch: load };
}
