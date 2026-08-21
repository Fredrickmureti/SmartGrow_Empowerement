/**
 * useReconciliationAssistant — Phase 6. The assistant advises; it never acts.
 *
 * Two advisory reads, both served by the `reconciliation-assistant` edge
 * function, which itself holds no elevated privilege: it reads through the
 * caller's own token, so the assistant can only ever see what the operator
 * could already see.
 *
 *  - `useCandidateAdvisory` — a suggested ORDER over the candidates the
 *    database produced, plus the reasoning and the risks in plain language.
 *    The order is advice. The candidates themselves still come from the
 *    database's own candidate seam, and confirming one still goes through the
 *    match confirmation seam with a human behind it.

 *  - `useHistoryNarrative` — a readable narration of the Phase 5 decision
 *    record for an auditor.
 *
 * Deliberately absent from this file: any mutation, any matching seam, any
 * posting call. If the assistant is unavailable the caller still renders — the
 * response carries `ai_available: false` and a reason, and the workflow
 * continues on the database's own ordering. Nothing here is load-bearing.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CandidateAdvisory {
  /** Indices into the server's candidate array, best first. Advice only. */
  ranking: number[];
  advisory: {
    recommendation: string | null;
    confidence: "high" | "medium" | "low";
    reasoning: string | null;
    risks: string[];
  } | null;
  tier: string;
  server_reason: string | null;
  ai_available: boolean;
  degraded_reason: string | null;
}

export interface HistoryNarrative {
  decision_count: number;
  explanation: {
    summary: string | null;
    narrative: string | null;
    open_questions: string[];
  } | null;
  ai_available: boolean;
  degraded_reason: string | null;
}

async function invokeAssistant<T>(
  action: "rank_candidates" | "explain_history",
  bankTransactionId: string,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("reconciliation-assistant", {
    body: { action, bank_transaction_id: bankTransactionId },
  });
  if (error) throw error;
  if (data && typeof data === "object" && "error" in (data as Record<string, unknown>)) {
    throw new Error(String((data as Record<string, unknown>).error));
  }
  return data as T;
}

/**
 * Advice on which candidate to look at first. `enabled` defaults to false so
 * this never fires on a worklist render — the operator asks for it on one
 * line at a time, which is also what keeps the context per-decision.
 */
export function useCandidateAdvisory(bankTransactionId?: string, enabled = false) {
  return useQuery({
    queryKey: ["reconciliation-assistant", "rank", bankTransactionId],
    enabled: !!bankTransactionId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => invokeAssistant<CandidateAdvisory>("rank_candidates", bankTransactionId as string),
  });
}

/** A readable narration of what the audit record already says. */
export function useHistoryNarrative(bankTransactionId?: string, enabled = false) {
  return useQuery({
    queryKey: ["reconciliation-assistant", "explain", bankTransactionId],
    enabled: !!bankTransactionId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => invokeAssistant<HistoryNarrative>("explain_history", bankTransactionId as string),
  });
}
