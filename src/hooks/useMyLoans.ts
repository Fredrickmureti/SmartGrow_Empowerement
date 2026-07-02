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
}

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
      const installments = Math.max(1, Number(input.total_installments || 1));
      // Provisional figures only — the approver/HR can adjust before activation.
      const totalAmount = principal;
      const monthly =
        input.repayment_method === "one_off_next_payroll"
          ? totalAmount
          : Math.max(1, Math.round((totalAmount / installments) * 100) / 100);

      const legacyLoanType =
        input.repayment_method === "one_off_next_payroll" ? "advance" : "loan";

      // Idempotency — re-submits within the same org with the same key
      // (e.g. a double-tap on "Submit" or a retried offline op) reuse the
      // existing row instead of duplicating the request.
      if (options?.idempotencyKey) {
        const { data: existing, error: existingErr } = await (supabase as any)
          .from("employee_loans")
          .select("*")
          .eq("organization_id", currentOrg.id)
          .eq("idempotency_key", options.idempotencyKey)
          .maybeSingle();
        if (existingErr) throw existingErr;
        if (existing) return existing;
      }

      const { data: loanNumber } = await (supabase as any).rpc("get_next_loan_number", {
        _org_id: currentOrg.id,
      });

      const { data, error } = await (supabase as any)
        .from("employee_loans")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? currentEmployee.business_id ?? null,
          employee_id: currentEmployee.id,
          loan_number: loanNumber || `LR-${Date.now()}`,
          loan_type: legacyLoanType,
          loan_type_id: input.loan_type_id,
          description: input.reason ?? null,
          principal_amount: principal,
          interest_rate: 0,
          total_amount: totalAmount,
          amount_repaid: 0,
          outstanding_balance: totalAmount,
          monthly_deduction: monthly,
          total_installments: installments,
          installments_paid: 0,
          start_date: input.start_date,
          end_date: null,
          status: "requested",
          repayment_method: input.repayment_method,
          requested_by: user.id,
          requested_at: new Date().toISOString(),
          created_by: user.id,
          notes: input.reason ?? null,
          idempotency_key: options?.idempotencyKey ?? null,
        })
        .select()
        .single();

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
      toast.error(err?.message || "Could not submit loan request");
    },
  });

  const cancelRequest = useMutation({
    mutationFn: async (loanId: string) => {
      const { error } = await (supabase as any)
        .from("employee_loans")
        .update({ status: "cancelled" })
        .eq("id", loanId)
        .eq("status", "requested");
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Request cancelled");
      invalidate();
    },
    onError: (err: any) => toast.error(err?.message || "Could not cancel request"),
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
