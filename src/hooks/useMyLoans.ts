/**
 * useMyLoans — own-rows scoped employee loan hook for /me/loans.
 *
 * Reads loans belonging to the currently signed-in employee (resolved via
 * `useCurrentEmployee` → `employees.user_id = auth.uid()`), and exposes a
 * `requestLoan` mutation that inserts a new row in `requested` state.
 *
 * RLS on `employee_loans` already lets:
 *   - employees SELECT rows where the employee row's user_id is theirs
 *   - employees INSERT rows in status='requested' for their own employee row
 *     (policy: employee_loans_insert_self_request)
 *   - employees UPDATE only their own 'requested' rows (cancel)
 * so this hook makes no privileged calls.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentEmployee } from "./useCurrentEmployee";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import type { EmployeeLoan } from "./useEmployeeLoans";
import type { RepaymentMethod } from "./useLoanTypes";
import { dispatchLoanNotification } from "@/lib/hr/loanNotifications";

export interface MyLoanRequestInput {
  loan_type_id: string;
  principal_amount: number;
  total_installments?: number | null;
  start_date: string;
  repayment_method: RepaymentMethod;
  reason?: string | null;
  /**
   * Payroll-deduction authorisation. Required by the RPC whenever the
   * loan type has `requires_consent` — the engine stamps
   * `consent_captured_at` / `consent_captured_by` on the loan row.
   */
  consent_acknowledged?: boolean;
  /** Required by the RPC when the loan type has `requires_collateral`. */
  collateral_description?: string | null;
}

/**
 * Friendly copy for the policy refusals raised by
 * `request_employee_loan` (Postgres HINT codes). Anything unmapped falls
 * back to the RPC's own message, which is already human-readable.
 */
const LOAN_ERROR_COPY: Record<string, string> = {
  LOAN_POLICY_CONSENT:
    "Please tick the payroll deduction authorisation before submitting.",
  LOAN_POLICY_COLLATERAL:
    "This loan requires you to describe the collateral you are offering.",
  LOAN_CONTEXT_AUTH: "Your session expired — sign in again to submit this request.",
  LOAN_POLICY_TYPE: "That loan product is not available to you.",
  LOAN_POLICY_TYPE_INACTIVE: "That loan product is no longer open for new requests.",
};


export interface MyLoanRequestOptions {
  /**
   * Idempotency key — if a request with the same (organization_id, key) is
   * already on file, the existing row is returned instead of inserting a
   * duplicate. Backed by the partial unique index
   * `idx_employee_loans_idempotency` (org_id, idempotency_key).
   */
  idempotencyKey?: string;
}

export function useMyLoans() {
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const employeeId = currentEmployee?.id ?? null;

  const query = useQuery({
    queryKey: ["my-loans", employeeId],
    enabled: !!employeeId,
    queryFn: async (): Promise<EmployeeLoan[]> => {
      const { data, error } = await (supabase as any)
        .from("employee_loans")
        .select(`*, type:loan_types(*)`)
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as EmployeeLoan[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["my-loans", employeeId] });

  /**
   * Employee self-service loan request.
   *
   * Delegates the entire creation + policy-validation + approval-workflow
   * bootstrap to the SECURITY DEFINER RPC `request_employee_loan` (Phase B
   * of the loan-types policy engine). The RPC:
   *   • refuses inactive loan types
   *   • validates principal / installments / tenure against the type's policy
   *   • enforces `requires_consent` and `requires_collateral`
   *   • opens an `approval_requests` row when the type requires approval
   *     (single-step, or two-step under `requires_dual_approval`)
   *   • is idempotent when `idempotency_key` is supplied
   *
   * The client no longer computes derived amounts or fills defaults — the
   * database is the single source of truth for loan policy.
   */
  const requestLoan = useMutation({
    mutationFn: async (
      args: MyLoanRequestInput | { input: MyLoanRequestInput; options?: MyLoanRequestOptions },
    ) => {
      const input: MyLoanRequestInput =
        "input" in args ? args.input : (args as MyLoanRequestInput);
      const options: MyLoanRequestOptions | undefined =
        "input" in args ? args.options : undefined;
      if (!user || !currentEmployee || !currentOrg) {
        throw new Error("Not signed in to an employee profile");
      }
      const principal = Number(input.principal_amount);
      if (!principal || principal <= 0) throw new Error("Enter a valid amount");

      const payload = {
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? currentEmployee.business_id ?? null,
        employee_id: currentEmployee.id,
        loan_type_id: input.loan_type_id,
        principal_amount: principal,
        total_installments: input.total_installments ?? null,
        start_date: input.start_date,
        repayment_method: input.repayment_method,
        reason: input.reason ?? null,
        idempotency_key: options?.idempotencyKey ?? null,
        // The wizard collects these whenever the loan type demands them;
        // the RPC re-checks and refuses if they are missing.
        consent_acknowledged: input.consent_acknowledged ?? false,
        collateral_description: input.collateral_description ?? null,
      };


      const { data, error } = await (supabase as any).rpc("request_employee_loan", {
        _input: payload,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      toast.success("Loan request submitted for approval");
      // Notify HR / payroll approvers that a request awaits action.
      // Fire-and-forget — never block or fail the submission on this.
      if (data?.id && currentOrg) {
        void dispatchLoanNotification({
          organizationId: currentOrg.id,
          loanId: data.id,
          event: "loan.requested",
          actorUserId: user?.id ?? null,
        });
      }
      invalidate();
    },
    onError: (err: any) => {
      const hint = typeof err?.hint === "string" ? err.hint : "";
      toast.error(
        LOAN_ERROR_COPY[hint] || err?.message || "Could not submit loan request",
      );
    },

  });

  const cancelRequest = useMutation({
    mutationFn: async (loanId: string) => {
      // ADR 0091 §10-§11 — loan state changes go through the lifecycle RPC,
      // never a direct status write: the RPC validates the transition and
      // emits the lifecycle event + outbox row.
      const { error } = await (supabase as any).rpc("employee_loan_cancel", {
        _loan_id: loanId,
        _reason: "Cancelled by employee",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Request cancelled");
      invalidate();
    },
    onError: (err: any) => {
      const hint = typeof err?.hint === "string" ? err.hint : "";
      toast.error(
        LOAN_ERROR_COPY[hint] || err?.message || "Could not cancel request",
      );
    },
  });


  const loans = query.data ?? [];
  return {
    loans,
    pendingRequests: loans.filter((l) => l.status === "requested" || l.status === "pending_approval"),
    activeLoans: loans.filter((l) => l.status === "active"),
    history: loans.filter((l) => ["completed", "cancelled", "rejected"].includes(l.status)),
    isLoading: query.isLoading,
    requestLoan,
    cancelRequest,
    refresh: () => invalidate(),
  };
}
