/**
 * useBankMatchCandidates — the evidence engine behind bank matching.
 *
 * The client never guesses what a bank line means. `bank_match_candidates`
 * answers that question server-side, inside the tenant boundary, and returns
 * the *reasons* alongside each candidate so an operator can judge it rather
 * than trust a score. A candidate's `allocations` are exactly the payload the
 * matching seam (`bank_match_propose` / `bank_match_confirm`) expects, so
 * accepting a suggestion and matching by hand travel the same road.
 *
 * Tiers:
 *  - `deterministic` — one candidate, corroborated by more than the amount.
 *  - `suggested`     — one candidate on amount and timing alone.
 *  - `ambiguous`     — several equally good candidates; a human must choose.
 *  - `weak`          — only a categorisation rule could explain the line.
 *  - `unresolved`    — nothing in the books explains it.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type BankMatchTier =
  | "deterministic"
  | "suggested"
  | "ambiguous"
  | "weak"
  | "unresolved";

export type BankMatchCandidateKind =
  | "payment"
  | "bill_payment"
  | "invoice"
  | "bill"
  | "transfer"
  | "account";

export interface BankMatchAllocation {
  document_type: BankMatchCandidateKind;
  document_id: string;
  amount: number;
  description?: string;
  mirror_transaction_id?: string;
}

export interface BankMatchCandidate {
  kind: BankMatchCandidateKind;
  label: string;
  /** Plain-English accounting consequence of accepting this candidate. */
  effect: string;
  party?: string | null;
  rule_id?: string | null;
  allocations: BankMatchAllocation[];
  /** Why this candidate is offered — never a bare percentage. */
  evidence: string[];
  score: number;
}

export interface BankMatchCandidateSet {
  bank_transaction_id: string;
  tier: BankMatchTier;
  candidates: BankMatchCandidate[];
}

const EMPTY: BankMatchCandidateSet = {
  bank_transaction_id: "",
  tier: "unresolved",
  candidates: [],
};

async function fetchCandidates(txnId: string): Promise<BankMatchCandidateSet> {
  const { data, error } = await (supabase as any).rpc("bank_match_candidates", {
    _txn_id: txnId,
    _limit: 10,
  });
  if (error) throw error;
  return (data as BankMatchCandidateSet) ?? { ...EMPTY, bank_transaction_id: txnId };
}

export function useBankMatchCandidates(txnId?: string, enabled = true) {
  return useQuery({
    queryKey: ["bank-match-candidates", txnId],
    queryFn: () => fetchCandidates(txnId as string),
    enabled: !!txnId && enabled,
    staleTime: 30_000,
  });
}

/** Batch variant for a worklist: one query per line, cached independently. */
export function useBankMatchCandidatesFor(txnIds: string[]) {
  const results = useQueries({
    queries: txnIds.map((id) => ({
      queryKey: ["bank-match-candidates", id],
      queryFn: () => fetchCandidates(id),
      staleTime: 30_000,
    })),
  });

  const byTransaction = new Map<string, BankMatchCandidateSet>();
  results.forEach((r, i) => {
    if (r.data) byTransaction.set(txnIds[i], r.data);
  });

  return {
    byTransaction,
    isLoading: results.some((r) => r.isLoading),
  };
}

export const TIER_COPY: Record<BankMatchTier, { label: string; hint: string }> = {
  deterministic: { label: "Certain", hint: "Corroborated by more than the amount." },
  suggested: { label: "Likely", hint: "Amount and timing agree — confirm the party." },
  ambiguous: { label: "Ambiguous", hint: "Several records fit equally well. Choose one." },
  weak: { label: "Rule only", hint: "No document explains this line; a rule would categorise it." },
  unresolved: { label: "Unexplained", hint: "Nothing in the books accounts for this line yet." },
};
