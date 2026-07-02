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
      const { data: userData } = await supabase.auth.getUser();

      const { data, error } = await supabase
        .from("bank_reconciliation_sessions")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || null,
          branch_id: scope.branchId ?? null,
          bank_account_id: params.bankAccountId,
          statement_date: params.statementDate,
          opening_balance: params.openingBalance,
          closing_balance: params.closingBalance,
          reconciled_balance: 0,
          status: "in_progress",
          created_by: userData.user?.id || null,
          service_charge_amount: params.serviceChargeAmount || null,
          service_charge_date: params.serviceChargeDate || null,
          service_charge_account_id: params.serviceChargeAccountId || null,
          interest_earned_amount: params.interestEarnedAmount || null,
          interest_earned_date: params.interestEarnedDate || null,
          interest_earned_account_id: params.interestEarnedAccountId || null,
        } as any)
        .select()
        .single();

      if (error) throw error;
      const session = data as unknown as ReconciliationSession;
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

  const updateSessionBalance = async (sessionId: string, reconciledBalance: number) => {
    try {
      const { error } = await supabase
        .from("bank_reconciliation_sessions")
        .update({ reconciled_balance: reconciledBalance, updated_at: new Date().toISOString() } as any)
        .eq("id", sessionId);

      if (error) throw error;

      setActiveSession(prev => prev && prev.id === sessionId
        ? { ...prev, reconciled_balance: reconciledBalance, difference: prev.closing_balance - prev.opening_balance - reconciledBalance }
        : prev
      );
    } catch (error) {
      console.error("Error updating session balance:", error);
    }
  };

  /**
   * Post service charge and interest earned JEs to GL.
   * Called during reconciliation completion.
   */
  const postReconciliationAdjustments = async (session: ReconciliationSession) => {
    // Get the bank account's linked GL account
    const { data: bankAccount } = await supabase
      .from("bank_accounts")
      .select("account_id")
      .eq("id", session.bank_account_id)
      .single();

    const bankGLAccountId = bankAccount?.account_id;
    if (!bankGLAccountId) {
      console.warn("Bank account has no linked GL account; skipping service charge/interest JEs");
      return;
    }

    // Post service charge JE: DR Service Charge Expense, CR Bank
    const serviceAmount = session.service_charge_amount || 0;
    if (serviceAmount > 0 && session.service_charge_account_id) {
      await postToGL({
        source_type: "bank_recon",
        source_id: session.id,
        source_subtype: "service_charge",
        reference: `Recon-SC-${session.statement_date}`,
        memo: `Bank service charge - Reconciliation ${session.statement_date}`,
        entry_date: session.service_charge_date || session.statement_date,
        entries: [
          { account_id: session.service_charge_account_id, debit_amount: serviceAmount, credit_amount: 0, description: "Bank service charge" },
          { account_id: bankGLAccountId, debit_amount: 0, credit_amount: serviceAmount, description: "Bank service charge" },
        ],
      });
    }

    // Post interest earned JE: DR Bank, CR Interest Income
    const interestAmount = session.interest_earned_amount || 0;
    if (interestAmount > 0 && session.interest_earned_account_id) {
      await postToGL({
        source_type: "bank_recon",
        source_id: session.id,
        source_subtype: "interest",
        reference: `Recon-INT-${session.statement_date}`,
        memo: `Interest earned - Reconciliation ${session.statement_date}`,
        entry_date: session.interest_earned_date || session.statement_date,
        entries: [
          { account_id: bankGLAccountId, debit_amount: interestAmount, credit_amount: 0, description: "Interest earned" },
          { account_id: session.interest_earned_account_id, debit_amount: 0, credit_amount: interestAmount, description: "Interest earned" },
        ],
      });
    }
  };

  const completeSession = async (sessionId: string, _clearedTransactionIds?: string[], computedDifference?: number) => {
    try {
      setIsSaving(true);
      const { data: userData } = await supabase.auth.getUser();

      const session = sessions.find(s => s.id === sessionId) || activeSession;
      // Use workspace-computed difference if provided (avoids stale session state),
      // fall back to session.difference for backward compatibility
      const diff = computedDifference !== undefined ? computedDifference : (session?.difference ?? 0);
      if (Math.abs(diff) > 0.01) {
        toast.error(`Cannot complete: difference of ${diff.toFixed(2)} remains`);
        return false;
      }

      // Post service charge / interest JEs to GL before marking complete
      if (session) {
        await postReconciliationAdjustments(session);
      }

      const { error } = await supabase
        .from("bank_reconciliation_sessions")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          completed_by: userData.user?.id || null,
        } as any)
        .eq("id", sessionId);

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

  const cancelSession = async (sessionId: string) => {
    try {
      setIsSaving(true);
      const { error } = await supabase
        .from("bank_reconciliation_sessions")
        .update({ status: "cancelled" } as any)
        .eq("id", sessionId);

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
    updateSessionBalance,
    completeSession,
    cancelSession,
    fetchSessions,
  };
}
