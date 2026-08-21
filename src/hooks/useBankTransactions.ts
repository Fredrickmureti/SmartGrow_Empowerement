import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { safeQueryRetry, type NormalizedError } from "@/services/resilience";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFiscalPeriods } from "./useFiscalPeriods";
import { useAuditLog } from "./useAuditLog";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";

/**
 * Phase 12 — Bank Feeds.
 *
 * Bank-feed transactions are scoped to (organization_id, business_id, branch_id).
 * Branch is inherited from the parent bank_account at import time, so the feed
 * list is filtered by the active Finance scope:
 *   - branch active → rows for that branch + company-wide rows (branch_id IS NULL)
 *   - consolidated  → all rows the user is authorized to see (RLS caps it)
 *
 * The branch parameter is also part of the React-effect dependency so a branch
 * switch always refetches and never leaves stale numbers on screen.
 */

const FRIENDLY_BANK_FEED_PERM_MSG =
  "You don't have permission to categorize or reconcile bank feed transactions in this scope. Ask a finance admin (owner/admin/accountant).";

function mapBankFeedPermErr(error: unknown): string | null {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  if (code === "42501" || msg.includes("INSUFFICIENT_PRIVILEGE") || msg.includes("row-level security")) {
    return FRIENDLY_BANK_FEED_PERM_MSG;
  }
  // F17 — a completed reconciliation shuts the window on its own lines.
  if (msg.includes("BANK_MATCH_SESSION_CLOSED") || msg.includes("BANK_UNRECONCILE_SESSION_CLOSED")) {
    return "This bank line sits inside a completed reconciliation. Reopen that reconciliation before changing how the line is explained.";
  }
  // ADR-0149 — the refusals the un-match pre-flight also reports, in the same
  // words, for the case where the write is attempted without one.
  if (msg.includes("BANK_UNRECONCILE_PERIOD_LOCKED") || msg.includes("period is closed")) {
    return "The accounting period containing this line is closed. Reopen the period, or post a correcting entry in an open period.";
  }
  if (msg.includes("BANK_UNRECONCILE_MISSING_SETTLEMENT")) {
    return "This line settled a document but its payment record is missing. Reverse the payment from the document before un-matching.";
  }
  if (msg.includes("BANK_UNRECONCILE_ENTRY_IS_REVERSAL")) {
    return "The posting behind this line is itself a reversal and cannot be voided again.";
  }
  if (msg.includes("BANK_OPENING_BALANCE_ALREADY_POSTED")) {
    return "This bank account already carries a posted opening balance. Classifying this line to the bank's own control account would count it twice.";
  }
  if (msg.includes("Cannot modify a posted journal entry")) {
    return "That posting is final. Void it and post a correction instead of editing it.";
  }
  return null;
}


export interface BankTransaction {
  id: string;
  organization_id: string;
  bank_account_id: string;
  external_transaction_id: string;
  transaction_date: string;
  posting_date: string | null;
  description: string;
  reference: string | null;
  amount: number;
  balance_after: number | null;
  transaction_type: "credit" | "debit";
  category: string | null;
  category_confidence: number | null;
  is_reconciled: boolean;
  /**
   * The resolution that explained this line. `payment` / `bill_payment` mean
   * money already recorded was cleared out of its holding account; `account`
   * is a plain classification. (ADR-0147 kinds.)
   */
  reconciled_type:
    | "invoice"
    | "expense"
    | "bill"
    | "transfer"
    | "manual"
    | "payment"
    | "bill_payment"
    | "account"
    | null;
  reconciled_entity_id: string | null;
  reconciled_at: string | null;
  reconciled_by: string | null;
  raw_data: Json;
  created_at: string;
  updated_at: string;
  journal_entry_id: string | null;
  ai_suggested_category: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  lifecycle_status: "imported" | "for_review" | "matched" | "reconciled" | "excluded";
  bank_account?: { name: string; bank_name: string };
}

export interface TransactionFilters {
  bankAccountId?: string;
  startDate?: string;
  endDate?: string;
  transactionType?: "credit" | "debit";
  isReconciled?: boolean;
  searchQuery?: string;
  lifecycleStatus?: string;
  page?: number;
  pageSize?: number;
}

export function useBankTransactions(filters: TransactionFilters = {}) {
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  /**
   * Load failures are STATE, not a toast. Landing on a banking page with a
   * slow link must never bombard the operator with "Failed to load" — the
   * surface renders an inline retry affordance from this instead.
   */
  const [loadError, setLoadError] = useState<NormalizedError | null>(null);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { isDateLocked } = useFiscalPeriods();
  const { logAction } = useAuditLog();
  const scope = useFinanceScope();

  const filtersKey = JSON.stringify(filters);

  // A3: Server-side pagination via RPC (Phase 12: branch-scoped).
  // Resilience contract: transport hiccups retry transparently and only a
  // settled, normalized failure reaches the UI.
  const fetchTransactions = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setTransactions([]);
      setTotalCount(0);
      setLoadError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const pageSize = filters.pageSize || 100;
    const pageOffset = (filters.page || 0) * pageSize;

    const { data, error } = await safeQueryRetry(
      () =>
        supabase.rpc("get_bank_transactions_paginated", {
          _org_id: currentOrg.id,
          _business_id: currentBusiness.id,
          _bank_account_id: filters.bankAccountId || null,
          _is_reconciled: filters.isReconciled ?? null,
          _transaction_type: filters.transactionType || null,
          _search_query: filters.searchQuery || null,
          _start_date: filters.startDate || null,
          _end_date: filters.endDate || null,
          _page_size: pageSize,
          _page_offset: pageOffset,
          _branch_id: scope.branchId,
        }),
      { maxRetries: 2, baseDelayMs: 400 },
    );

    if (error) {
      // Keep whatever is already on screen — a transient failure must not
      // blank out data the operator was reading.
      console.error("[banking] transactions load failed:", error.kind, error.cause);
      setLoadError(error);
      setIsLoading(false);
      return;
    }

    const rows = (data || []) as any[];
    const mapped: BankTransaction[] = rows.map((r: any) => ({
      ...r,
      bank_account: r.bank_account_name ? { name: r.bank_account_name, bank_name: r.bank_name } : undefined,
      lifecycle_status: r.lifecycle_status || "for_review",
    }));
    setTransactions(mapped);
    setTotalCount(rows.length > 0 ? Number(rows[0].total_count) : 0);
    setLoadError(null);
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId, filtersKey]);

  useEffect(() => {
    if (currentOrg?.id && currentBusiness?.id) {
      fetchTransactions();
    }
    // Phase 12: include scope.branchId so branch switches refetch and never
    // leave another branch's bank-feed numbers on screen.
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId, filtersKey, fetchTransactions]);

  /**
   * Reconcile a bank transaction through the canonical matching seam
   * (Wave 2 Phase 10): `bank_match_propose` states the allocation set,
   * `bank_match_confirm` settles it through the AR/AP engines and the single
   * posting engine. Partial and multi-document matches are expressed by
   * passing `allocations`; a bank charge is the `feeAmount` residual.
   */
  const reconcileTransaction = async (
    transactionId: string,
    reconcileData: {
      reconciled_type:
        | "invoice"
        | "expense"
        | "bill"
        | "transfer"
        | "manual"
        | "payment"
        | "bill_payment";
      reconciled_entity_id?: string;
      category?: string;
      createGLEntry?: boolean;
      offsetAccountId?: string;
      /**
       * n:m allocations. When omitted, derived from the legacy single-entity
       * shape. `payment` / `bill_payment` clear money that is already
       * recorded (a deposit or a cheque presenting); `invoice` / `bill`
       * record new settlement. The distinction is the difference between
       * banking a receipt and inventing a second one.
       */
      allocations?: Array<{
        document_type:
          | "invoice"
          | "bill"
          | "account"
          | "payment"
          | "bill_payment"
          | "transfer";
        document_id: string;
        amount: number;
        description?: string;
      }>;
      /** Bank charge absorbed on this line (allocations + fee must equal the line). */
      feeAmount?: number;
      feeAccountId?: string;
    }
  ) => {
    try {
      setIsSaving(true);

      const { data: userData } = await supabase.auth.getUser();
      const txn = transactions.find(t => t.id === transactionId);
      if (!txn) throw new Error("Transaction not found");

      // A1: Fiscal period lock enforcement on bank reconciliation
      if (isDateLocked(txn.transaction_date)) {
        throw new Error(`Cannot reconcile: fiscal period for ${txn.transaction_date} is closed and locked.`);
      }

      const fee = reconcileData.feeAmount ?? 0;
      const allocations = reconcileData.allocations ?? (() => {
        // Amount law (mirrors `_bank_match_validate`): documents settle GROSS.
        // On money in the bank received less than was settled by the charge;
        // on money out it paid more.
        const inflow =
          (txn.transaction_type ?? (Number(txn.amount) >= 0 ? "credit" : "debit")) === "credit";
        const amount = Math.abs(Number(txn.amount)) + (inflow ? fee : -fee);
        const kind = reconcileData.reconciled_type;
        if (kind === "invoice" || kind === "bill" || kind === "payment" || kind === "bill_payment") {
          if (!reconcileData.reconciled_entity_id) {
            throw new Error("A document must be selected to reconcile this line.");
          }
          return [{
            document_type: kind,
            document_id: reconcileData.reconciled_entity_id,
            amount,
          }];
        }
        if (!reconcileData.offsetAccountId) {
          throw new Error("An offset account is required to classify this bank line.");
        }
        return [{
          document_type: "account" as const,
          document_id: reconcileData.offsetAccountId,
          amount,
          description: reconcileData.category ?? undefined,
        }];
      })();

      const { data: proposed, error: proposeError } = await (supabase as any).rpc("bank_match_propose", {
        _txn_id: transactionId,
        _allocations: allocations,
        _fee_amount: fee,
        _match_type: "manual",
        _rule_id: null,
        _notes: reconcileData.category ?? null,
        _user_id: userData.user?.id || null,
      });
      if (proposeError) throw proposeError;

      const matchId = (proposed as { match_id?: string } | null)?.match_id;
      if (!matchId) throw new Error("Match proposal did not return an identifier.");

      const { error } = await (supabase as any).rpc("bank_match_confirm", {
        _match_id: matchId,
        _user_id: userData.user?.id || null,
        // Deterministic per bank line: a double-click or retry collapses onto
        // the same settlement instead of minting a second payment (D5).
        _client_request_id: `brecon:${transactionId}`,
      });

      if (error) throw error;


      // Audit log
      logAction({
        action: "confirmed",
        entityType: "bank_transaction",
        entityId: transactionId,
        entityName: txn.description,
        changesSummary: `Reconciled as ${reconcileData.reconciled_type}${reconcileData.reconciled_entity_id ? ` to ${reconcileData.reconciled_entity_id.slice(0, 8)}` : ""}`,
      });
      
      toast.success("Transaction reconciled successfully");
      await fetchTransactions();
    } catch (error: unknown) {
      console.error("Error reconciling transaction:", error);
      const friendly = mapBankFeedPermErr(error);
      const message = friendly ?? (error instanceof Error ? error.message : "Failed to reconcile transaction");
      toast.error(message);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Unreconcile through the canonical database RPC.
   * Preserves imported bank data and reverses reconciliation lifecycle state server-side.
   */
  const unreconcileTransaction = async (transactionId: string) => {
    try {
      setIsSaving(true);
      const { data: userData } = await supabase.auth.getUser();

      const { data: txnData } = await supabase
        .from("bank_transactions")
        .select("id, description, reconciled_type, reconciled_entity_id")
        .eq("id", transactionId)
        .single();

      if (!txnData) throw new Error("Transaction not found");

      const { data: result, error } = await (supabase as any).rpc("unreconcile_bank_transaction", {
        _bank_transaction_id: transactionId,
        _reason: "Unreconciled from bank reconciliation workspace",
        _user_id: userData.user?.id ?? null,
      });

      if (error) throw error;

      // Audit log
      logAction({
        action: "reversed",
        entityType: "bank_transaction",
        entityId: transactionId,
        entityName: txnData.description,
        changesSummary: `Unreconciled from ${txnData.reconciled_type || "unknown"}`,
        oldValues: { reconciled_type: txnData.reconciled_type, reconciled_entity_id: txnData.reconciled_entity_id },
      });

      // Name the accounting consequence: a reversal is a posting, not a flag.
      const voided = Number((result as any)?.voided_entries ?? 0);
      if ((result as any)?.already_unreconciled) {
        toast.success("This line was already un-matched");
      } else if (voided > 0) {
        toast.success(
          voided === 1
            ? "Match reversed — 1 posting voided by a dated reversing entry"
            : `Match reversed — ${voided} postings voided by dated reversing entries`,
        );
      } else {
        toast.success("Match reversed — no posting had been created, so nothing was voided");
      }
      await fetchTransactions();

    } catch (error: unknown) {
      console.error("Error unreconciling transaction:", error);
      toast.error(mapBankFeedPermErr(error) ?? "Failed to unreconcile transaction");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Phase 4 (Banking reconstruction) — categorization is a server-side write
   * seam. `authenticated` no longer holds UPDATE on bank_transactions, so the
   * RPC is the only path: it re-checks the finance permission per business
   * and stamps the confidence alongside the category.
   */
  const updateCategory = async (transactionId: string, category: string) => {
    try {
      setIsSaving(true);
      const { error } = await (supabase as any).rpc("bank_transaction_set_category", {
        _transaction_ids: [transactionId],
        _category: category,
        _confidence: 1.0,
      });

      if (error) throw error;
      toast.success("Category updated");
      await fetchTransactions();
    } catch (error: unknown) {
      console.error("Error updating category:", error);
      const friendly = mapBankFeedPermErr(error);
      toast.error(friendly ?? "Failed to update category");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };


  /**
   * Auto-match — the browser asks the evidence engine; it never decides.
   *
   * This used to be a second matching engine living in the client: it fetched
   * every open invoice and bill, scored them on amount / reference / name, sent
   * the leftovers to an LLM, and auto-posted anything scoring >= 0.85. That
   * bypassed `bank_match_candidates` entirely, so a receipt already recorded in
   * Undeposited Funds was invisible to it and the invoice was settled a second
   * time — precisely the duplicate ADR-0147 exists to prevent — and it let a
   * score, not evidence, drive a posting.
   *
   * Now the server answers. For each selected line the engine returns a tier
   * and, for each candidate, the allocations plus the reasons behind them.
   * Only the `deterministic` tier — one candidate, corroborated by more than
   * the amount — may be applied without a human, and it is applied through the
   * same propose + confirm seam and the same per-line idempotency key as a
   * hand-match, so a retry collapses onto one settlement.
   *
   * Everything else is returned for review. Ambiguity is an answer, not a
   * failure.
   */
  const AUTO_MATCH_MAX_LINES = 200;

  const autoMatchTransactions = async (transactionIds: string[]) => {
    if (!currentOrg?.id) return null;

    try {
      const targets = transactions
        .filter((t) => transactionIds.includes(t.id) && !t.is_reconciled)
        .slice(0, AUTO_MATCH_MAX_LINES);
      if (targets.length === 0) return null;

      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id ?? null;

      let applied = 0;
      const needsReview: Array<{
        transaction_id: string;
        tier: string;
        candidates: number;
      }> = [];
      const failures: Array<{ transaction_id: string; message: string }> = [];

      for (const txn of targets) {
        const { data: cands, error: candErr } = await (supabase as any).rpc(
          "bank_match_candidates",
          { _txn_id: txn.id, _limit: 3 },
        );
        if (candErr) {
          failures.push({ transaction_id: txn.id, message: candErr.message });
          continue;
        }

        const tier = (cands?.tier as string) ?? "unresolved";
        const candidates = (cands?.candidates as Array<Record<string, unknown>>) ?? [];

        // Only a corroborated, unambiguous answer may post unattended. The
        // engine already refuses to call a tie deterministic, so the top
        // candidate here is the single best-evidenced one.
        if (tier !== "deterministic" || candidates.length === 0) {
          needsReview.push({ transaction_id: txn.id, tier, candidates: candidates.length });
          continue;
        }


        try {
          const { data: proposed, error: proposeError } = await (supabase as any).rpc(
            "bank_match_propose",
            {
              _txn_id: txn.id,
              _allocations: candidates[0].allocations,
              _fee_amount: 0,
              _match_type: "manual",
              _rule_id: (candidates[0].rule_id as string) ?? null,
              _notes: (candidates[0].label as string) ?? null,
              _user_id: userId,
            },
          );
          if (proposeError) throw proposeError;

          const matchId = (proposed as { match_id?: string } | null)?.match_id;
          if (!matchId) throw new Error("Match proposal did not return an identifier.");

          const { error: confirmError } = await (supabase as any).rpc("bank_match_confirm", {
            _match_id: matchId,
            _user_id: userId,
            _client_request_id: `brecon:${txn.id}`,
          });
          if (confirmError) throw confirmError;

          applied += 1;
          logAction({
            action: "confirmed",
            entityType: "bank_transaction",
            entityId: txn.id,
            entityName: txn.description,
            changesSummary: `Auto-matched: ${candidates[0].label ?? "deterministic candidate"}`,
          });
        } catch (e: unknown) {
          // A line the engine refuses stays open for a human. It is never
          // downgraded into a weaker posting to make the run look successful.
          failures.push({
            transaction_id: txn.id,
            message: e instanceof Error ? e.message : "Could not apply this match",
          });
          needsReview.push({ transaction_id: txn.id, tier, candidates: candidates.length });
        }
      }

      if (applied > 0) {
        toast.success(`Reconciled ${applied} line${applied > 1 ? "s" : ""} with certain matches`);
        await fetchTransactions();
      }

      return {
        applied,
        needsReview,
        failures,
        summary: {
          total: targets.length,
          applied,
          needsReview: needsReview.length,
          skipped: transactionIds.length - targets.length,
        },
      };
    } catch (error: unknown) {
      console.error("Error auto-matching transactions:", error);
      toast.error("Failed to auto-match transactions");
      return null;
    }
  };


  const stats = {
    totalTransactions: transactions.length,
    reconciledCount: transactions.filter(t => t.is_reconciled).length,
    unreconciledCount: transactions.filter(t => !t.is_reconciled).length,
    totalCredits: transactions.filter(t => t.transaction_type === "credit").reduce((sum, t) => sum + Number(t.amount), 0),
    totalDebits: transactions.filter(t => t.transaction_type === "debit").reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0),
  };

  return {
    transactions,
    totalCount,
    isLoading,
    isSaving,
    loadError,
    stats,
    fetchTransactions,
    reconcileTransaction,
    unreconcileTransaction,
    updateCategory,
    autoMatchTransactions,
  };
}
