/**
 * useBankPendingMatch — the open proposal on a bank line, and the two seams
 * that answer it.
 *
 * `bank_match_candidates` deliberately offers nothing while a line already
 * carries an open match (ADR-0148): speculating about an explained line is how
 * a replayed statement mints a second settlement. But an operator still has to
 * be able to *see* that proposal and either confirm or reject it — otherwise
 * the line is silently blocked and the only remaining route is a hand-match,
 * which is exactly the mistake the engine exists to prevent.
 *
 * Confirming and rejecting go through the canonical seams
 * (`bank_match_confirm` / `bank_match_reject`); nothing here writes
 * `bank_reconciliation_matches` or the reconciled state directly (ADR-0144 §1).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface PendingMatchAllocation {
  document_type: string;
  document_id: string;
  amount: number;
  description?: string;
}

export interface PendingBankMatch {
  id: string;
  status: string;
  match_type: string | null;
  notes: string | null;
  fee_amount: number;
  allocations: PendingMatchAllocation[];
}

/** Statuses that mean "a human still owes this line an answer". */
const OPEN_STATUSES = ["suggested", "to_check"];

export function useBankPendingMatch(txnId?: string, enabled = true) {
  return useQuery({
    queryKey: ["bank-pending-match", txnId],
    enabled: !!txnId && enabled,
    staleTime: 10_000,
    queryFn: async (): Promise<PendingBankMatch | null> => {
      const { data, error } = await supabase
        .from("bank_reconciliation_matches")
        .select("id, status, match_type, notes, fee_amount, allocations, created_at")
        .eq("bank_transaction_id", txnId as string)
        .in("status", OPEN_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const raw = row.allocations;
      return {
        id: String(row.id),
        status: String(row.status),
        match_type: (row.match_type as string) ?? null,
        notes: (row.notes as string) ?? null,
        fee_amount: Number(row.fee_amount) || 0,
        allocations: Array.isArray(raw) ? (raw as PendingMatchAllocation[]) : [],
      };
    },
  });
}

/** Confirm or reject an open proposal through the matching seam. */
export function usePendingMatchActions(txnId?: string) {
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["bank-pending-match", txnId] });
    queryClient.invalidateQueries({ queryKey: ["bank-match-candidates", txnId] });
    queryClient.invalidateQueries({ queryKey: ["bank-transactions"] });
  };

  const confirm = useMutation({
    mutationFn: async (matchId: string) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await (supabase as any).rpc("bank_match_confirm", {
        _match_id: matchId,
        _user_id: userData.user?.id ?? null,
        // Deterministic per bank line: a retry collapses onto the same
        // settlement instead of minting a second one.
        _client_request_id: `brecon:${txnId}`,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Match confirmed — the line is reconciled");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not confirm this match");
    },
  });

  const reject = useMutation({
    mutationFn: async (matchId: string) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await (supabase as any).rpc("bank_match_reject", {
        _match_id: matchId,
        _user_id: userData.user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Proposal rejected — this line is open again");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not reject this match");
    },
  });

  return { confirm, reject };
}
