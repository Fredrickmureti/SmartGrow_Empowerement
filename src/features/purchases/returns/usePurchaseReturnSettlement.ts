/**
 * usePurchaseReturnSettlement — how the return's debit note landed on the
 * supplier's liability.
 *
 * A return is only financially closed when the vendor debit note has been
 * applied against a supplier bill. Both sides are server-owned:
 * `vendor_credit_notes` is written by `create_vendor_credit_note_atomic` and
 * `vendor_credit_note_applications` by the AP allocation engine. This hook
 * READS them so the record page can show applied / remaining without
 * recomputing an allocation in the browser.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ReturnSettlement {
  creditNote: {
    id: string;
    credit_note_number: string | null;
    status: string | null;
    total: number;
    amount_applied: number;
    currency: string | null;
  } | null;
  bill: {
    id: string;
    bill_number: string | null;
    status: string | null;
    total: number;
  } | null;
  /** Amount of the debit note applied to the linked bill specifically. */
  appliedToBill: number;
}

const EMPTY: ReturnSettlement = { creditNote: null, bill: null, appliedToBill: 0 };

export function usePurchaseReturnSettlement(
  creditNoteId: string | null | undefined,
  billId: string | null | undefined,
) {
  const [settlement, setSettlement] = useState<ReturnSettlement>(EMPTY);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!creditNoteId && !billId) {
      setSettlement(EMPTY);
      return;
    }
    setLoading(true);

    const [cnRes, billRes, appRes] = await Promise.all([
      creditNoteId
        ? supabase
            .from("vendor_credit_notes")
            .select("id, credit_note_number, status, total, amount_applied, currency")
            .eq("id", creditNoteId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      billId
        ? supabase
            .from("bills")
            .select("id, bill_number, status, total")
            .eq("id", billId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      creditNoteId && billId
        ? supabase
            .from("vendor_credit_note_applications")
            .select("amount")
            .eq("credit_note_id", creditNoteId)
            .eq("bill_id", billId)
        : Promise.resolve({ data: [] }),
    ]);

    const cn = (cnRes as { data: Record<string, unknown> | null }).data;
    const bill = (billRes as { data: Record<string, unknown> | null }).data;
    const apps = ((appRes as { data: { amount: number | null }[] | null }).data ?? []);

    setSettlement({
      creditNote: cn
        ? {
            id: String(cn.id),
            credit_note_number: (cn.credit_note_number as string) ?? null,
            status: (cn.status as string) ?? null,
            total: Number(cn.total ?? 0),
            amount_applied: Number(cn.amount_applied ?? 0),
            currency: (cn.currency as string) ?? null,
          }
        : null,
      bill: bill
        ? {
            id: String(bill.id),
            bill_number: (bill.bill_number as string) ?? null,
            status: (bill.status as string) ?? null,
            total: Number(bill.total ?? 0),
          }
        : null,
      appliedToBill: apps.reduce((sum, a) => sum + Number(a.amount ?? 0), 0),
    });
    setLoading(false);
  }, [creditNoteId, billId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { settlement, loading, refetch: load };
}
