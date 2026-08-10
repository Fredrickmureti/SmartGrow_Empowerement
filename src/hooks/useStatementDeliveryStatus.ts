/**
 * Statement delivery outcomes, per customer.
 *
 * Collections needs to answer "did the reminder actually reach them?" without
 * leaving the page. The answer lives in `customer_statement_send_jobs`: the
 * durable queue that owns every bulk statement send, including its retry count
 * and terminal failure reason. The worker writes the outcome there and the
 * underlying `send-document-email` call writes the audit row to
 * `document_emails` — so this hook reads state, it never re-derives it.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export type StatementDeliveryState = "queued" | "sending" | "sent" | "failed";

export interface StatementDelivery {
  contactId: string;
  state: StatementDeliveryState;
  attempts: number;
  lastError: string | null;
  at: string | null;
}

const STATE_MAP: Record<string, StatementDeliveryState> = {
  pending: "queued",
  queued: "queued",
  claimed: "sending",
  processing: "sending",
  sent: "sent",
  completed: "sent",
  failed: "failed",
  dead: "failed",
};

export function useStatementDeliveryStatus() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["statement-delivery-status", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, StatementDelivery>> => {
      let q = supabase
        .from("customer_statement_send_jobs" as any)
        .select("contact_id, status, attempts, last_error, completed_at, created_at")
        .eq("organization_id", currentOrg!.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);

      const { data, error } = await q;
      if (error) throw error;

      const latest: Record<string, StatementDelivery> = {};
      for (const row of (data || []) as any[]) {
        if (!row.contact_id || latest[row.contact_id]) continue; // ordered desc → first wins
        latest[row.contact_id] = {
          contactId: row.contact_id,
          state: STATE_MAP[row.status] ?? "queued",
          attempts: Number(row.attempts) || 0,
          lastError: row.last_error ?? null,
          at: row.completed_at ?? row.created_at ?? null,
        };
      }
      return latest;
    },
  });
}
