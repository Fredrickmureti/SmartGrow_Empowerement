/**
 * useVendorOpenBills — this supplier's bills that still owe money.
 *
 * Feeds the targeted "apply credit to a specific bill" dialog. The list is
 * advisory only: the server re-reads the bill under lock and re-checks the
 * balance, the vendor match and the available credit before it applies
 * anything.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface VendorOpenBill {
  id: string;
  bill_number: string | null;
  bill_date: string | null;
  due_date: string | null;
  total: number | null;
  amount_paid: number | null;
  currency: string | null;
}

export function useVendorOpenBills(
  vendorId: string | null | undefined,
  businessId: string | null | undefined,
) {
  const [bills, setBills] = useState<VendorOpenBill[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!vendorId || !businessId) {
      setBills([]);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("bills")
      .select("id, bill_number, bill_date, due_date, total, amount_paid, currency" as string)
      .eq("vendor_id", vendorId)
      .eq("business_id", businessId)
      .not("status", "in", "(paid,void,cancelled,draft)")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(200);
    if (!error) {
      const rows = (data ?? []) as unknown as VendorOpenBill[];
      setBills(rows.filter((b) => (b.total ?? 0) - (b.amount_paid ?? 0) > 0.01));
    }
    setLoading(false);
  }, [vendorId, businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { bills, loading, refetch: load };
}
