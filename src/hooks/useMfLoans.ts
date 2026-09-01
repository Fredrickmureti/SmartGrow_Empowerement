/**
 * Microfinance loans, contractual schedules and disbursement (C6).
 *
 * Nothing financial is computed here. The loan is minted from an approved
 * application by `mf_create_loan_from_application`, which snapshots the frozen
 * product version onto the loan and generates the contractual schedule
 * server-side. Disbursement is a guarded, idempotent event
 * (`mf_disburse_loan`) that realigns the schedule to the real value date and
 * writes an append-only loan event. React only collects intent and renders.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export type MfLoanStatus =
  | "pending_disbursement"
  | "active"
  | "closed"
  | "written_off"
  | "cancelled";

export const MF_LOAN_STATUSES: MfLoanStatus[] = [
  "pending_disbursement",
  "active",
  "closed",
  "written_off",
  "cancelled",
];

export const MF_LOAN_STATUS_LABELS: Record<MfLoanStatus, string> = {
  pending_disbursement: "Pending disbursement",
  active: "Active",
  closed: "Closed",
  written_off: "Written off",
  cancelled: "Cancelled",
};

export const MF_DISBURSEMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "cheque", label: "Cheque" },
] as const;

export interface MfLoan {
  id: string;
  business_id: string;
  branch_id: string | null;
  loan_number: string;
  application_id: string;
  client_id: string;
  group_id: string | null;
  product_id: string;
  product_version_id: string;
  loan_officer_id: string | null;
  currency_code: string;
  principal: number;
  term_installments: number;
  repayment_frequency: string;
  interest_method: string;
  interest_rate: number;
  interest_rate_period: string;
  grace_period_installments: number;
  penalty_rate: number;
  penalty_basis: string | null;
  expected_disbursement_date: string | null;
  first_installment_date: string | null;
  status: MfLoanStatus;
  disbursed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MfLoanScheduleRow {
  id: string;
  loan_id: string;
  installment_no: number;
  due_date: string;
  opening_balance: number;
  principal_due: number;
  interest_due: number;
  fees_due: number;
  total_due: number;
  closing_balance: number;
  is_grace: boolean;
}

export interface MfLoanEvent {
  id: string;
  loan_id: string;
  event_type: string;
  event_at: string;
  actor_id: string | null;
  amount: number | null;
  payload: Record<string, unknown>;
}

const LOAN_SELECT =
  "id,business_id,branch_id,loan_number,application_id,client_id,group_id,product_id,product_version_id,loan_officer_id,currency_code,principal,term_installments,repayment_frequency,interest_method,interest_rate,interest_rate_period,grace_period_installments,penalty_rate,penalty_basis,expected_disbursement_date,first_installment_date,status,disbursed_at,closed_at,created_at,updated_at";

function friendly(error: unknown, fallback: string): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/already been disbursed|already has a loan/i.test(msg)) return msg;
  if (/row-level security/i.test(msg)) {
    return "You do not have permission to perform this action.";
  }
  return msg || fallback;
}

/** Loans for the institution, newest first. */
export function useMfLoans(options?: { status?: MfLoanStatus | "all"; clientId?: string }) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const status = options?.status ?? "all";
  const clientId = options?.clientId;

  const query = useQuery({
    queryKey: ["mf-loans", businessId, status, clientId ?? null],
    queryFn: async () => {
      if (!businessId) return [] as MfLoan[];
      let q = supabase
        .from("mf_loans")
        .select(LOAN_SELECT)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      if (status !== "all") q = q.eq("status", status);
      if (clientId) q = q.eq("client_id", clientId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfLoan[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-loans"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loan-schedule"] });
    queryClient.invalidateQueries({ queryKey: ["mf-applications"] });
  };

  /** Mint the contractual loan from an approved application (server-side). */
  const createFromApplication = useMutation({
    mutationFn: async (input: {
      applicationId: string;
      expectedDisbursementDate?: string | null;
      firstInstallmentDate?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("mf_create_loan_from_application", {
        p_application_id: input.applicationId,
        p_expected_disbursement_date: input.expectedDisbursementDate ?? null,
        p_first_installment_date: input.firstInstallmentDate ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Loan created with its contractual schedule");
    },
    onError: (e) => toast.error(friendly(e, "Could not create the loan")),
  });

  /** Guarded, single-shot disbursement event. */
  const disburse = useMutation({
    mutationFn: async (input: {
      loanId: string;
      disbursedOn: string;
      amount: number;
      method: string;
      reference?: string | null;
      sourceAccountId?: string | null;
      receivedByName?: string | null;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("mf_disburse_loan", {
        p_loan_id: input.loanId,
        p_disbursed_on: input.disbursedOn,
        p_amount: input.amount,
        p_method: input.method,
        p_reference: input.reference ?? null,
        p_source_account_id: input.sourceAccountId ?? null,
        p_received_by_name: input.receivedByName ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Loan disbursed");
    },
    onError: (e) => toast.error(friendly(e, "The disbursement was refused")),
  });

  return {
    loans: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    createFromApplication,
    disburse,
    businessId,
  };
}

/** Contractual schedule and event history for one loan. */
export function useMfLoanSchedule(loanId?: string) {
  const schedule = useQuery({
    queryKey: ["mf-loan-schedule", loanId],
    queryFn: async () => {
      if (!loanId) return [] as MfLoanScheduleRow[];
      const { data, error } = await supabase
        .from("mf_loan_schedule")
        .select(
          "id,loan_id,installment_no,due_date,opening_balance,principal_due,interest_due,fees_due,total_due,closing_balance,is_grace",
        )
        .eq("loan_id", loanId)
        .order("installment_no");
      if (error) throw error;
      return (data ?? []) as MfLoanScheduleRow[];
    },
    enabled: !!loanId,
  });

  const events = useQuery({
    queryKey: ["mf-loan-events", loanId],
    queryFn: async () => {
      if (!loanId) return [] as MfLoanEvent[];
      const { data, error } = await supabase
        .from("mf_loan_events")
        .select("id,loan_id,event_type,event_at,actor_id,amount,payload")
        .eq("loan_id", loanId)
        .order("event_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as MfLoanEvent[];
    },
    enabled: !!loanId,
  });

  return {
    schedule: schedule.data ?? [],
    events: events.data ?? [],
    isLoading: schedule.isLoading,
    error: schedule.error as Error | null,
  };
}
