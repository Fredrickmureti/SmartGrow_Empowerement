/**
 * Billing history for one recurring template — the operator-facing view of
 * `recurring_invoice_runs`.
 *
 * Every billing occurrence leaves a row here: the period it covered, whether
 * an invoice was produced and posted, the failure reason when it was not, and
 * the delivery outcome. This is what makes "why was this invoice generated?"
 * and "why was September not billed?" answerable.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface RecurringInvoiceRun {
  id: string;
  recurring_invoice_id: string;
  period_start: string;
  period_end: string;
  status: "claimed" | "generated" | "posted" | "failed" | "skipped";
  invoice_id: string | null;
  invoice_number: string | null;
  journal_entry_id: string | null;
  failure_reason: string | null;
  delivery_status: "pending" | "not_applicable" | "queued" | "sent" | "failed";
  delivery_error: string | null;
  delivered_at: string | null;
  attempt_count: number;
  trigger_source: "schedule" | "manual" | "api";
  created_at: string;
}

export function useRecurringInvoiceRuns(recurringId: string | null | undefined) {
  return useQuery({
    queryKey: ["recurring-invoice-runs", recurringId],
    enabled: !!recurringId,
    queryFn: async (): Promise<RecurringInvoiceRun[]> => {
      const { data, error } = await supabase
        .from("recurring_invoice_runs" as never)
        .select("*")
        .eq("recurring_invoice_id", recurringId!)
        .order("period_start", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data as unknown as RecurringInvoiceRun[]) ?? [];
    },
  });
}
