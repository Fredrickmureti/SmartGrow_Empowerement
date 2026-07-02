/**
 * Employee Loans & Advances hook (Stage 5/6 redesign).
 *
 * - Backed by configurable `loan_types` (no hardcoded enum).
 * - Exposes pause / resume / disburse / settle and schedule access.
 * - Compute-payroll consumes the `loan_repayment_schedule` rows; this hook
 *   owns lifecycle / UI state only.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "./usePermissions";
import { toast } from "sonner";
import { dispatchLoanNotification, type LoanLifecycleEvent } from "@/lib/hr/loanNotifications";
import type { LoanType, RepaymentMethod } from "./useLoanTypes";

export interface EmployeeLoan {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  loan_number: string;
  loan_type: string;            // legacy text — kept for compatibility
  loan_type_id: string | null;  // NEW — primary FK to loan_types
  description: string | null;
  principal_amount: number;
  interest_rate: number;
  total_amount: number;
  amount_repaid: number;
  outstanding_balance: number;
  monthly_deduction: number;
  total_installments: number;
  installments_paid: number;
  start_date: string;
  end_date: string | null;
  status:
    | "requested"
    | "pending_approval"
    | "approved"
    | "awaiting_disbursement"
    | "rejected"
    | "draft"
    | "active"
    | "in_arrears"
    | "completed"
    | "cancelled"
    | "suspended"
    | "written_off"
    | "settled";
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Stage 5/6 columns
  repayment_method: RepaymentMethod;
  repayment_percent: number | null;
  min_net_pay_floor: number | null;
  max_pct_of_net: number | null;
  paused_until: string | null;
  disbursement_journal_entry_id: string | null;
  settlement_journal_entry_id: string | null;
  disbursed_at: string | null;
  // Self-service request workflow (Wave 1)
  requested_by?: string | null;
  requested_at?: string | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  // Joins
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
  };
  type?: LoanType | null;
}

export interface LoanRepayment {
  id: string;
  loan_id: string;
  payroll_run_id: string | null;
  payslip_id: string | null;
  amount: number;
  repayment_date: string;
  installment_number: number;
  notes: string | null;
  created_at: string;
}

export interface LoanScheduleRow {
  id: string;
  loan_id: string;
  sequence: number;
  due_period_start: string | null;
  due_period_end: string | null;
  scheduled_amount: number;
  paid_amount: number;
  status: "pending" | "paid" | "partial" | "skipped" | "cancelled";
  payslip_id: string | null;
  repayment_id: string | null;
  notes: string | null;
}

export interface CreateLoanInput {
  employee_id: string;
  loan_type_id: string;
  description?: string | null;
  principal_amount: number;
  interest_rate?: number;
  total_installments?: number;
  start_date: string;
  repayment_method: RepaymentMethod;
  repayment_percent?: number | null;
  min_net_pay_floor?: number | null;
  max_pct_of_net?: number | null;
  monthly_deduction?: number | null;
  notes?: string | null;
}

export function useEmployeeLoans() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [loans, setLoans] = useState<EmployeeLoan[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLoans = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    try {
      let query = (supabase as any)
        .from("employee_loans")
        .select(`
          *,
          employee:employees(id, first_name, last_name, employee_number),
          type:loan_types(*)
        `)
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (currentBusiness?.id) query = query.eq("business_id", currentBusiness.id);
      const { data, error } = await query;
      if (error) throw error;
      setLoans((data || []) as EmployeeLoan[]);
    } catch (err: any) {
      console.error("Error fetching loans:", err);
      toast.error("Failed to fetch employee loans");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => { fetchLoans(); }, [fetchLoans]);

  /**
   * Fire-and-forget HR lifecycle notification. Never blocks or throws into
   * the caller — a failed notification must not roll back the loan action.
   */
  const notifyLoanEvent = (loanId: string, event: LoanLifecycleEvent) => {
    if (!currentOrg) return;
    void dispatchLoanNotification({
      organizationId: currentOrg.id,
      loanId,
      event,
      actorUserId: user?.id ?? null,
    });
  };

  const createLoan = async (input: CreateLoanInput) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (!can("manageEmployeeLoans")) {
      toast.error("You don't have permission to manage loans");
      throw new Error("Permission denied");
    }

    const principal = Number(input.principal_amount);
    const interest = Number(input.interest_rate || 0) / 100;
    const installments = Math.max(1, Number(input.total_installments || 1));
    const totalAmount = principal * (1 + interest);
    const monthly = input.monthly_deduction
      ? Number(input.monthly_deduction)
      : input.repayment_method === "one_off_next_payroll"
        ? totalAmount
        : Math.round((totalAmount / installments) * 100) / 100;

    // Resolve a legacy text value so the (loan|advance) check constraint passes
    const legacyLoanType =
      input.repayment_method === "one_off_next_payroll" ? "advance" : "loan";

    const { data: loanNumber } = await (supabase as any).rpc("get_next_loan_number", {
      _org_id: currentOrg.id,
    });

    const { data, error } = await (supabase as any)
      .from("employee_loans")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        employee_id: input.employee_id,
        loan_number: loanNumber || `LN-${Date.now()}`,
        loan_type: legacyLoanType,
        loan_type_id: input.loan_type_id,
        description: input.description ?? null,
        principal_amount: principal,
        interest_rate: Number(input.interest_rate || 0),
        total_amount: totalAmount,
        amount_repaid: 0,
        outstanding_balance: totalAmount,
        monthly_deduction: monthly,
        total_installments: installments,
        installments_paid: 0,
        start_date: input.start_date,
        end_date: null,
        status: "draft",
        repayment_method: input.repayment_method,
        repayment_percent: input.repayment_percent ?? null,
        min_net_pay_floor: input.min_net_pay_floor ?? null,
        max_pct_of_net: input.max_pct_of_net ?? null,
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;
    toast.success(`Loan ${data.loan_number} created`);
    await fetchLoans();
    return data;
  };

  /**
   * Approve a loan request end-to-end.
   *
   * Sequence (C1 fix):
   *   1. Capture prior status so we can revert if the GL post fails.
   *   2. Flip status -> 'active' + record approver/approved_at.
   *   3. Generate repayment schedule (RPC; safe for percent-of-net loans).
   *   4. Invoke `post-loan-disbursement` so the loan receivable / clearing
   *      JE is posted. This is idempotent server-side.
   *   5. If the JE post fails, revert status to 'pending_approval' so HR
   *      can fix the GL mapping (typical cause) and retry without losing
   *      the request. Any prior schedule rows are harmless to leave —
   *      they'll be regenerated on the next approve attempt.
   */
  /**
   * Approve a loan request via the lifecycle RPC.
   *
   * After Phase L-A the RPC moves status to 'approved' (not 'active') and
   * the SoD guard rejects creator/beneficiary self-approval. Disbursement
   * authorisation + bank posting are now distinct steps.
   */
  const approveLoan = async (id: string) => {
    if (!user || !can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { data, error } = await (supabase as any).rpc("employee_loan_lifecycle_approve", { _loan_id: id });
    if (error) throw error;
    toast.success("Loan approved");
    notifyLoanEvent(id, "loan.approved");
    await fetchLoans();
    return data;
  };

  /** Authorize the approved loan for disbursement (Finance/Treasury). */
  const authorizeDisbursement = async (id: string) => {
    if (!user || !can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_authorize_disbursement", { _loan_id: id });
    if (error) throw error;
    toast.success("Disbursement authorized");
    await fetchLoans();
  };

  /** Rejected via RPC so the lifecycle event ledger captures it. */
  const rejectLoan = async (id: string, reason: string) => {
    if (!user || !can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_lifecycle_reject", { _loan_id: id, _reason: reason });
    if (error) throw error;
    toast.success("Loan request rejected");
    notifyLoanEvent(id, "loan.rejected");
    await fetchLoans();
  };
  const suspendLoan = async (id: string, reason?: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_suspend", { _loan_id: id, _reason: reason ?? null });
    if (error) throw error;
    toast.success("Loan suspended");
    await fetchLoans();
  };

  const cancelLoan = async (id: string, reason?: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_cancel", { _loan_id: id, _reason: reason ?? null });
    if (error) throw error;
    toast.success("Loan cancelled");
    await fetchLoans();
  };

  const pauseLoan = async (id: string, until: string, reason?: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_pause_recovery", {
      _loan_id: id, _until: until, _reason: reason ?? null,
    });
    if (error) throw error;
    toast.success(`Loan paused until ${until}`);
    await fetchLoans();
  };

  const resumeLoan = async (id: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_resume_recovery", { _loan_id: id });
    if (error) throw error;
    toast.success("Loan resumed");
    await fetchLoans();
  };

  /**
   * Disburse — moves status to 'disbursed' on success. The lifecycle RPC
   * `employee_loan_mark_disbursed` is invoked server-side by the edge
   * function via the bank-account posting path.
   */
  const disburseLoan = async (id: string, bankAccountId: string, valueDate?: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { data, error } = await (supabase as any).functions.invoke("post-loan-disbursement", {
      body: { loan_id: id, bank_account_id: bankAccountId, value_date: valueDate || new Date().toISOString().slice(0, 10) },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    toast.success("Loan disbursed and posted to GL");
    notifyLoanEvent(id, "loan.disbursed");
    await fetchLoans();
    return data;
  };

  const settleLoan = async (id: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { data, error } = await (supabase as any).functions.invoke("post-loan-settlement", {
      body: { loan_id: id },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    toast.success("Loan settled");
    await fetchLoans();
    return data;
  };

  /** Write-off (Phase L-D). Dual-control enforced by SoD trigger. */
  const writeOffLoan = async (id: string, reason: string, journalDate?: string) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_write_off", {
      _loan_id: id, _reason: reason, _journal_date: journalDate ?? new Date().toISOString().slice(0, 10),
    });
    if (error) throw error;
    toast.success("Loan written off");
    notifyLoanEvent(id, "loan.written_off");
    await fetchLoans();
  };

  /** Restructure / top-up / consolidate (Phase L-I). */
  const restructureLoan = async (
    id: string,
    params: { new_principal?: number; new_term_months?: number; new_interest_rate?: number; reason: string },
  ) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_restructure", {
      _loan_id: id,
      _new_principal: params.new_principal ?? null,
      _new_term_months: params.new_term_months ?? null,
      _new_interest_rate: params.new_interest_rate ?? null,
      _reason: params.reason,
    });
    if (error) throw error;
    toast.success("Loan restructured; new schedule generated");
    await fetchLoans();
  };

  /** Record an off-payroll repayment (cash/bank/external). */
  const recordManualRepayment = async (
    id: string,
    amount: number,
    paymentDate: string,
    bankAccountId: string,
    reference?: string,
  ) => {
    if (!can("manageEmployeeLoans")) throw new Error("Permission denied");
    const { error } = await (supabase as any).rpc("employee_loan_record_manual_repayment", {
      _loan_id: id,
      _amount: amount,
      _payment_date: paymentDate,
      _bank_account_id: bankAccountId,
      _reference: reference ?? null,
    });
    if (error) throw error;
    toast.success("Manual repayment recorded");
    await fetchLoans();
  };


  const previewSchedule = async (loanId: string): Promise<LoanScheduleRow[]> => {
    const { data, error } = await (supabase as any).rpc("generate_loan_schedule", {
      _loan_id: loanId,
      _dry_run: true,
    });
    if (error) throw error;
    return ((data?.rows as any[]) || []).map((r, i) => ({
      id: `preview-${i}`,
      loan_id: loanId,
      sequence: r.sequence,
      due_period_start: r.due_period_start,
      due_period_end: r.due_period_end,
      scheduled_amount: Number(r.scheduled_amount),
      paid_amount: 0,
      status: "pending",
      payslip_id: null,
      repayment_id: null,
      notes: null,
    }));
  };

  const getSchedule = async (loanId: string): Promise<LoanScheduleRow[]> => {
    const { data, error } = await (supabase as any)
      .from("loan_repayment_schedule")
      .select("*")
      .eq("loan_id", loanId)
      .order("sequence");
    if (error) throw error;
    return (data || []) as LoanScheduleRow[];
  };

  const getRepayments = async (loanId: string): Promise<LoanRepayment[]> => {
    const { data, error } = await (supabase as any)
      .from("loan_repayments")
      .select("*")
      .eq("loan_id", loanId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []) as LoanRepayment[];
  };

  return {
    loans,
    activeLoans: loans.filter((l) => l.status === "active"),
    pendingRequests: loans.filter(
      (l) => l.status === "requested" || l.status === "pending_approval",
    ),
    isLoading,
    createLoan,
    approveLoan,
    authorizeDisbursement,
    rejectLoan,
    suspendLoan,
    cancelLoan,
    pauseLoan,
    resumeLoan,
    disburseLoan,
    settleLoan,
    writeOffLoan,
    restructureLoan,
    recordManualRepayment,
    previewSchedule,
    getSchedule,
    getRepayments,
    refreshLoans: fetchLoans,
  };
}
