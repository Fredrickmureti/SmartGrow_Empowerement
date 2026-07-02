import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

/**
 * ADR 0027 — Reallocation primitive.
 *
 * Wraps the `reallocate_payment_atomic` RPC. The RPC is append-only:
 * compensating negative allocation rows are inserted for the prior
 * live state and positive rows for the new state. Invoice paid totals
 * and the parent payment's applied / outstanding amounts are recomputed
 * inside the transaction, and a `payment_reversal_events` audit row is
 * written (op='reallocate', reason='payment_reallocated').
 */
export interface NewAllocationInput {
  invoice_id: string;
  amount: number;
}

interface ReallocateArgs {
  paymentId: string;
  newAllocations: NewAllocationInput[];
  reason?: string;
  actor?: string | null;
}

export function useReallocatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ReallocateArgs) => {
      const { data, error } = await supabase.rpc("reallocate_payment_atomic" as any, {
        _payment_id: args.paymentId,
        _new_allocations: args.newAllocations,
        _reason: args.reason ?? null,
        _actor: args.actor ?? null,
      });
      if (error) throw error;
      return data as {
        payment_id: string;
        event_id: string;
        new_applied: number;
        new_outstanding: number;
        touched_invoices: string[];
      };
    },
    onSuccess: (_data, args) => {
      toast({ title: "Payment reallocated", description: "Allocations updated and audit trail recorded." });
      qc.invalidateQueries({ queryKey: ["payment-allocations", args.paymentId] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customer-ledger"] });
      qc.invalidateQueries({ queryKey: ["customer-outstanding-balance"] });
      qc.invalidateQueries({ queryKey: ["customer-statements"] });
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Reallocation failed",
        description: err?.message || String(err),
      });
    },
  });
}

/**
 * Fetches the customer's currently-open invoices (anything with a positive
 * remaining balance) so the reallocation dialog can build a target list.
 * Pass the payment's `currency` so cross-currency invoices are filtered out
 * (the DB allocation trigger would reject them anyway).
 */
export function useReallocationTargets({
  contactId,
  businessId,
  currency,
  includeInvoiceIds,
}: {
  contactId?: string | null;
  businessId?: string | null;
  currency?: string | null;
  /** Always include these invoice IDs even if currently paid (e.g. currently allocated invoices). */
  includeInvoiceIds?: string[];
}) {
  return useQuery({
    queryKey: ["reallocation-targets", contactId, businessId, currency, includeInvoiceIds?.slice().sort().join(",")],
    enabled: !!contactId,
    staleTime: 10_000,
    queryFn: async () => {
      if (!contactId) return [];
      let q = supabase
        .from("invoices")
        .select("id, invoice_number, total, amount_paid, status, currency, issue_date, due_date")
        .eq("contact_id", contactId)
        .not("status", "in", "(draft,voided,cancelled)")
        .order("issue_date", { ascending: true });
      if (businessId) q = q.eq("business_id", businessId);
      if (currency) q = q.eq("currency", currency);
      const { data, error } = await q;
      if (error) throw error;
      const all = (data ?? []) as any[];
      const includeSet = new Set(includeInvoiceIds ?? []);
      return all
        .filter((i) => includeSet.has(i.id) || Number(i.total) - Number(i.amount_paid) > 0.005)
        .map((i) => ({
          id: i.id as string,
          invoice_number: i.invoice_number as string,
          total: Number(i.total) || 0,
          amount_paid: Number(i.amount_paid) || 0,
          remaining: Math.max(Number(i.total) - Number(i.amount_paid), 0),
          status: String(i.status),
          currency: i.currency as string | null,
          issue_date: i.issue_date as string | null,
          due_date: i.due_date as string | null,
        }));
    },
  });
}
