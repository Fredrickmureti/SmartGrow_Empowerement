/**
 * Phase 4 P2 — payslip lifecycle journal reader.
 *
 * Reads `public.payslip_events` for a single payslip in chronological order.
 * Pure read; RLS scopes the result to HR users with payroll read or the
 * payslip's owning employee. Append-only by policy + trigger — the UI does
 * not need to worry about mutation or pagination beyond ordering.
 *
 * Country-agnostic: the event vocabulary is a generic enum (generated,
 * recomputed, approved, posted, paid, cancelled, corrected, superseded,
 * reissued, viewed, downloaded, emailed, signed). No statutory or
 * jurisdiction-specific reasoning here.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PayslipEventType =
  | "generated"
  | "recomputed"
  | "approved"
  | "posted"
  | "paid"
  | "cancelled"
  | "corrected"
  | "superseded"
  | "reissued"
  | "viewed"
  | "downloaded"
  | "emailed"
  | "signed";

export interface PayslipEvent {
  id: string;
  payslip_id: string;
  event_type: PayslipEventType;
  actor_user_id: string | null;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export function usePayslipEvents(payslipId: string | null | undefined) {
  return useQuery<PayslipEvent[]>({
    queryKey: ["payslip_events", payslipId],
    enabled: !!payslipId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payslip_events")
        .select("id, payslip_id, event_type, actor_user_id, occurred_at, metadata")
        .eq("payslip_id", payslipId!)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PayslipEvent[];
    },
    staleTime: 30_000,
  });
}
