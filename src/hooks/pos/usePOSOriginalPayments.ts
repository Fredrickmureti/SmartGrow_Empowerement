import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface POSOriginalPayment {
  payment_method: string;
  amount: number;
}

/**
 * Stage 4 closeout — list of payment methods used on the *original* sale.
 * The Return dialog uses this to detect cross-tender refunds (refund tender
 * not in this list) and gate the action behind a manager PIN. The DB RPC
 * re-checks the same condition server-side.
 */
export function usePOSOriginalPayments(transactionId: string | null | undefined) {
  return useQuery({
    queryKey: ["pos-original-payments", transactionId],
    enabled: !!transactionId,
    staleTime: 60_000,
    queryFn: async (): Promise<POSOriginalPayment[]> => {
      const { data, error } = await supabase
        .from("pos_transaction_payments")
        .select("payment_method, amount, status")
        .eq("transaction_id", transactionId!)
        .gt("amount", 0);
      if (error) throw error;
      return (data ?? [])
        .filter((p: any) => (p.status ?? "completed") === "completed")
        .map((p: any) => ({ payment_method: p.payment_method, amount: Number(p.amount) }));
    },
  });
}
