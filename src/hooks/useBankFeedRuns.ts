import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Phase 18.3 — feed observability.
 *
 * One row per sync attempt from `bank_feed_runs`: the window it asked the
 * provider for, what came back (fetched / inserted / duplicate / rejected),
 * what triggered it and why it failed. Read-only: the browser never writes
 * feed state, and RLS decides which runs are visible.
 */
export interface BankFeedRun {
  id: string;
  connection_id: string;
  bank_account_id: string;
  status: string;
  trigger_source: string | null;
  window_from: string | null;
  window_to: string | null;
  fetched_count: number | null;
  inserted_count: number | null;
  duplicate_count: number | null;
  rejected_count: number | null;
  statement_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export function useBankFeedRuns(bankAccountId: string | null, limit = 20) {
  return useQuery({
    queryKey: ["bank-feed-runs", bankAccountId, limit],
    enabled: !!bankAccountId,
    queryFn: async (): Promise<BankFeedRun[]> => {
      const { data, error } = await supabase
        .from("bank_feed_runs")
        .select(
          "id, connection_id, bank_account_id, status, trigger_source, window_from, window_to, fetched_count, inserted_count, duplicate_count, rejected_count, statement_id, error_code, error_message, started_at, finished_at",
        )
        .eq("bank_account_id", bankAccountId!)
        .order("started_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []) as BankFeedRun[];
    },
  });
}
