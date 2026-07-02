import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Allocation-first read model for a single customer payment.
 *
 * Reads from `payment_allocations` — the canonical 1:N link between a payment
 * and the invoices it settles. Both `record_payment_atomic` (single-invoice)
 * and `record_multi_invoice_payment` (multi) write rows here; the legacy
 * `payments.invoice_id` column is NOT the source of truth and must not be
 * consumed by new UI.
 *
 * Returned shape includes the invoice snapshot at fetch time so the detail
 * UI can render: invoice number link, allocated amount, invoice total,
 * remaining balance after this allocation, and current status.
 */
export interface PaymentAllocation {
  id: string;
  invoice_id: string;
  amount: number;
  created_at: string;
  invoice: {
    id: string;
    invoice_number: string;
    total: number;
    amount_paid: number;
    status: string;
    currency: string | null;
    issue_date: string | null;
  } | null;
}

export function usePaymentAllocations(paymentId?: string | null) {
  const query = useQuery({
    queryKey: ["payment-allocations", paymentId],
    queryFn: async (): Promise<PaymentAllocation[]> => {
      if (!paymentId) return [];
      const { data, error } = await supabase
        .from("payment_allocations")
        .select(
          "id, invoice_id, amount, created_at, invoice:invoices(id, invoice_number, total, amount_paid, status, currency, issue_date)",
        )
        .eq("payment_id", paymentId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return (data ?? []).map((row: any) => ({
        id: row.id,
        invoice_id: row.invoice_id,
        amount: Number(row.amount) || 0,
        created_at: row.created_at,
        invoice: row.invoice
          ? {
              id: row.invoice.id,
              invoice_number: row.invoice.invoice_number,
              total: Number(row.invoice.total) || 0,
              amount_paid: Number(row.invoice.amount_paid) || 0,
              status: String(row.invoice.status),
              currency: row.invoice.currency ?? null,
              issue_date: row.invoice.issue_date ?? null,
            }
          : null,
      }));
    },
    enabled: !!paymentId,
    staleTime: 15_000,
  });

  const allocations = query.data ?? [];
  const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);

  return {
    allocations,
    totalAllocated,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
