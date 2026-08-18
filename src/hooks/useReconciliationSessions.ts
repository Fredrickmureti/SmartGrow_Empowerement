import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useGLPosting } from "./useGLPosting";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { toast } from "sonner";

/**
 * Phase 13 — Bank Reconciliation.
 *
 * Reconciliation sessions are scoped to (organization, business, branch)
 * and gated by the `finance.reconcile_bank` finance permission. The
 * branch is inherited from the parent bank account at session start; the
 * RLS policies + `assert_can_reconcile_bank` server helper enforce the
 * same rule defense-in-depth.
 */
const FRIENDLY_RECONCILE_PERM_MSG =
  "You don't have permission to reconcile bank transactions in this scope. Ask a finance admin (owner/admin/accountant).";

function mapReconcilePermErr(error: unknown): string | null {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  if (
    code === "42501" ||
    msg.includes("INSUFFICIENT_PRIVILEGE_RECONCILE") ||
    msg.includes("row-level security")
  ) {
    return FRIENDLY_RECONCILE_PERM_MSG;
  }
  // R4: only one open reconciliation per bank account
  if (code === "23505" && msg.includes("bank_reconciliation_one_open_per_account")) {
    return "Another reconciliation is already in progress for this bank account. Resume or cancel it before starting a new one.";
  }
  return null;
}

export interface ReconciliationSession {
  id: string;
  organization_id: string;
  business_id: string | null;
  bank_account_id: string;
  statement_date: string;
  opening_balance: number;
  closing_balance: number;
  reconciled_balance: number;
  difference: number;
  status: "in_progress" | "completed" | "cancelled";
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  // Service charge / interest fields
  service_charge_amount?: number;
  service_charge_date?: string;
  service_charge_account_id?: string;
  interest_earned_amount?: number;
  interest_earned_date?: string;
  interest_earned_account_id?: string;
}

export function useReconciliationSessions(bankAccountId?: string) {
  const [sessions, setSessions] = useState<ReconciliationSession[]>([]);
  const [activeSession, setActiveSession] = useState<ReconciliationSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { postToGL } = useGLPosting();
  const scope = useFinanceScope();
  const { allowed: canReconcile } = useFinancePermission("finance.reconcile_bank");

  const fetchSessions = useCallback(async () => {
    if (!currentOrg?.id) return;
    try {
      setIsLoading(true);
      let query = supabase
        .from("bank_reconciliation_sessions")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });

      if (currentBusiness?.id) query = query.eq("business_id", currentBusiness.id);
      if (bankAccountId) query = query.eq("bank_account_id", bankAccountId);
      // Branch filter: when a branch is selected, include rows for that
      // branch OR company-wide (NULL) sessions. Consolidated mode (no
      // branch) returns all branches of the active business.
      if (scope.branchId) {
        query = query.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      }

      const { data, error } = await query;
      if (error) throw error;
      const typed = (data || []) as unknown as ReconciliationSession[];
      setSessions(typed);

      // Find active (in_progress) session
      const active = typed.find(s => s.status === "in_progress");
      setActiveSession(active || null);
    } catch (error) {
      console.error("Error fetching reconciliation sessions:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId, bankAccountId]);

  useEffect(() => {
    if (currentOrg?.id) fetchSessions();
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId, fetchSessions]);

  /**
   * Phase 4 (Banking reconstruction) — the reconciliation lifecycle is
   * server-owned. The browser no longer inserts sessions, computes the
   * cleared balance, or posts adjustment/write-off journal entries: each
   * call below is a single SECURITY DEFINER RPC that applies the permission,
   * account-lifecycle and fiscal-period gates and does its GL posting inside
   * one transaction. Direct INSERT/UPDATE/DELETE on
   * bank_reconciliation_sessions / _items is revoked from `authenticated`.
   */
  const startSession = async (params: {
    bankAccountId: string;
    statementDate: string;
    openingBalance: number;
    closingBalance: number;
    serviceChargeAmount?: number;
    serviceChargeDate?: string;
    serviceChargeAccountId?: string;
    interestEarnedAmount?: number;
    interestEarnedDate?: string;
    interestEarnedAccountId?: string;
  }) => {
    if (!currentOrg?.id) return null;
    try {
      setIsSaving(true);
      const { data, error } = await (supabase as any).rpc("bank_reconciliation_session_start", {
        _bank_account_id: params.bankAccountId,
        _statement_date: params.statementDate,
        _opening_balance: params.openingBalance,
        _closing_balance: params.closingBalance,
        _adjustments: {
          service_charge_amount: params.serviceChargeAmount ?? null,
          service_charge_date: params.serviceChargeDate ?? null,
          service_charge_account_id: params.serviceChargeAccountId ?? null,
          interest_earned_amount: params.interestEarnedAmount ?? null,
          interest_earned_date: params.interestEarnedDate ?? null,
          interest_earned_account_id: params.interestEarnedAccountId ?? null,
        },
      });

      if (error) throw error;
      const session = (data as any)?.session as ReconciliationSession | undefined;
      if (!session) throw new Error("Reconciliation session was not returned by the server");
      setActiveSession(session);
      setSessions(prev => [session, ...prev]);
      toast.success("Reconciliation session started");
      return session;
    } catch (error) {
      console.error("Error starting session:", error);
      const friendly = mapReconcilePermErr(error);
      toast.error(friendly ?? "Failed to start reconciliation session");
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Write off a residual difference within the allowed threshold. The server
   * recomputes the difference itself, posts the balancing JE through the
   * canonical posting engine and records it on the session.
   */
  const writeOffSession = async (sessionId: string, maxAmount = 5.0) => {
    try {
      setIsSaving(true);
      const { data, error } = await (supabase as any).rpc("bank_reconciliation_session_writeoff", {
        _session_id: sessionId,
        _max_amount: maxAmount,
      });
      if (error) throw error;
      await fetchSessions();
      toast.success("Difference written off");
      return data as Record<string, unknown>;
    } catch (error) {
      console.error("Error writing off difference:", error);
      toast.error(mapReconcilePermErr(error) ?? "Failed to write off difference");
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const completeSession = async (sessionId: string) => {
    try {
      setIsSaving(true);
      const { error } = await (supabase as any).rpc("bank_reconciliation_session_complete", {
        _session_id: sessionId,
      });
      if (error) throw error;

      setActiveSession(null);
      await fetchSessions();
      toast.success("Reconciliation session completed");
      return true;
    } catch (error) {
      console.error("Error completing session:", error);
      toast.error(mapReconcilePermErr(error) ?? "Failed to complete session");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const cancelSession = async (sessionId: string, reason?: string) => {
    try {
      setIsSaving(true);
      const { error } = await (supabase as any).rpc("bank_reconciliation_session_cancel", {
        _session_id: sessionId,
        _reason: reason ?? null,
      });
      if (error) throw error;
      setActiveSession(null);
      await fetchSessions();
      toast.success("Reconciliation session cancelled");
      return true;
    } catch (error) {
      console.error("Error cancelling session:", error);
      toast.error(mapReconcilePermErr(error) ?? "Failed to cancel session");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  return {
    sessions,
    activeSession,
    isLoading,
    isSaving,
    canReconcile,
    scope,
    startSession,
    writeOffSession,
    completeSession,
    cancelSession,
    fetchSessions,
  };
}

