/**
 * useBankMatchHistory — explainability, not decision-making.
 *
 * A reconciled bank line is an accounting assertion: "this money is that
 * document". Anyone auditing the books has to be able to ask *why* that
 * assertion exists — on what evidence, by which rule or by whose hand, when,
 * and whether it was later corrected. Phase 5 of the reconciliation wave adds
 * exactly that read, and nothing more.
 *
 * Two rules hold this seam honest:
 *  1. The browser never SELECTs `bank_reconciliation_matches` for history. It
 *     calls `bank_match_history` / `bank_match_session_history`, which assert
 *     business *and* branch scope inside the database (an org-wide read policy
 *     leaked other businesses' reconciliation decisions before this phase).
 *  2. These are read-only. No proposing, confirming, reversing or posting lives
 *     here — explaining is not deciding (ADR-0144 §1).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type BankMatchHistoryEventKind = "proposed" | "confirmed" | "rejected" | "reversed";

export interface BankMatchHistoryEvent {
  event: BankMatchHistoryEventKind;
  at: string;
  actor_id: string | null;
  actor: string | null;
  /** `manual`, or the rule name that proposed the match. */
  basis: string | null;
  detail: string | null;
}

export interface BankMatchAllocationRecord {
  document_type?: string;
  document_id?: string;
  amount?: number;
  description?: string;
}

export interface BankMatchDecision {
  match_id: string;
  bank_transaction_id: string;
  status: string;
  match_type: string | null;
  matched_amount: number | null;
  residual_amount: number | null;
  fee_amount: number | null;
  fee_account_id: string | null;
  exchange_rate: number | null;
  confidence: number | null;
  rule_id: string | null;
  rule_name: string | null;
  origin: "rule" | "manual";
  allocations: BankMatchAllocationRecord[];
  evidence: Record<string, unknown>;
  journal_entry_id: string | null;
  fee_journal_entry_id: string | null;
  adjustment_journal_entry_id: string | null;
  is_reversed: boolean;
  created_at: string;
  updated_at: string;
  events: BankMatchHistoryEvent[];
}

export interface BankLineHistory {
  bank_transaction_id: string;
  transaction_date: string;
  description: string | null;
  reference: string | null;
  amount: number;
  transaction_type: string | null;
  match_source: string | null;
  decisions: BankMatchDecision[];
}

export interface BankSessionHistoryEntry {
  bank_transaction_id: string;
  transaction_date: string;
  description: string | null;
  reference: string | null;
  amount: number;
  transaction_type: string | null;
  match_source: string | null;
  decision: BankMatchDecision;
}

export interface BankSessionHistory {
  session_id: string;
  statement_date: string;
  status: string;
  opening_balance: number | null;
  closing_balance: number | null;
  difference: number | null;
  completed_at: string | null;
  completed_by: string | null;
  completed_by_name: string | null;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  entries: BankSessionHistoryEntry[];
}

/** Every decision ever taken on one bank line, oldest first. */
export function useBankMatchHistory(bankTransactionId?: string, enabled = true) {
  return useQuery({
    queryKey: ["bank-match-history", bankTransactionId],
    enabled: !!bankTransactionId && enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<BankLineHistory | null> => {
      const { data, error } = await (supabase as any).rpc("bank_match_history", {
        p_bank_transaction_id: bankTransactionId,
      });
      if (error) throw error;
      return (data as BankLineHistory) ?? null;
    },
  });
}

/** The audit trail of every line a reconciliation session touched. */
export function useBankSessionMatchHistory(sessionId?: string, enabled = true) {
  return useQuery({
    queryKey: ["bank-match-session-history", sessionId],
    enabled: !!sessionId && enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<BankSessionHistory | null> => {
      const { data, error } = await (supabase as any).rpc("bank_match_session_history", {
        p_session_id: sessionId,
      });
      if (error) throw error;
      return (data as BankSessionHistory) ?? null;
    },
  });
}

/** Plain-English sentence for one timeline event. */
export function describeMatchEvent(event: BankMatchHistoryEvent): string {
  const who = event.actor ?? "Unknown user";
  switch (event.event) {
    case "proposed":
      return event.basis && event.basis !== "manual"
        ? `Proposed by rule “${event.basis}”`
        : `Matched by hand by ${who}`;
    case "confirmed":
      return `Confirmed by ${who}`;
    case "rejected":
      return `Rejected by ${who}`;
    case "reversed":
      return `Reversed by ${who} — the earlier decision was corrected`;
    default:
      return who;
  }
}
