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
import { lendingErrorMessage } from "@/lib/lending/lendingError";

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

/** How a loan came into existence: fresh, a top-up, or a restructure. */
export type MfLoanLineageKind = "new" | "topup" | "restructure";

export const MF_LINEAGE_LABELS: Record<MfLoanLineageKind, string> = {
  new: "New",
  topup: "Top-up",
  restructure: "Restructure",
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
  /** Frozen on the loan: how its interest is collected. */
  interest_collection: "with_installments" | "deducted_upfront";
  grace_period_installments: number;
  penalty_rate: number;
  penalty_basis: string | null;
  expected_disbursement_date: string | null;
  first_installment_date: string | null;
  status: MfLoanStatus;
  disbursed_at: string | null;
  closed_at: string | null;
  parent_loan_id: string | null;
  lineage_kind: MfLoanLineageKind;
  settled_by_loan_id: string | null;
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
  /**
   * Borrower-facing split. For loans whose interest is deducted upfront the
   * stored `interest_due` is zero, so the server-side display view re-splits
   * the installment into its principal and interest components.
   */
  principal_component: number;
  interest_component: number;
  /** Interest already released from the holding account to income. */
  interest_recognised: number;
  is_interest_recognised: boolean;
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
  "id,business_id,branch_id,loan_number,application_id,client_id,group_id,product_id,product_version_id,loan_officer_id,currency_code,principal,term_installments,repayment_frequency,interest_method,interest_rate,interest_rate_period,interest_collection,grace_period_installments,penalty_rate,penalty_basis,expected_disbursement_date,first_installment_date,status,disbursed_at,closed_at,parent_loan_id,lineage_kind,settled_by_loan_id,created_at,updated_at";


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
    queryClient.invalidateQueries({ queryKey: ["mf-loan-balances"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loan-events"] });
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
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not create the loan")),
  });

  /**
   * Guarded, single-shot disbursement event.
   *
   * An optional payout-desk photo is attached *after* the money event has
   * succeeded: identity evidence must never be able to fail a cash movement.
   */
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
      payoutPhoto?: Blob | null;
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
      const disbursementId = data as string;

      if (input.payoutPhoto && businessId) {
        try {
          await attachDisbursementPhoto({
            businessId,
            loanId: input.loanId,
            disbursementId,
            file: input.payoutPhoto,
          });
        } catch (e) {
          toast.error(
            lendingErrorMessage(
              e,
              "The loan was disbursed, but the payout photo could not be saved",
            ),
          );
        }
      }
      return disbursementId;
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["mf-loan-disbursement"] });
      toast.success("Loan disbursed");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The disbursement was refused")),
  });

  /**
   * Financial integrity: reverse a disbursement made in error. The server
   * reverses the original journal entry, returns the loan to
   * `pending_disbursement` and restores the contractual schedule. Refused once
   * any receipt exists on the loan.
   */
  const reverseDisbursement = useMutation({
    mutationFn: async (input: { loanId: string; reason: string }) => {
      const { data: rows, error: findError } = await supabase
        .from("mf_loan_disbursements")
        .select("id")
        .eq("loan_id", input.loanId)
        .is("reversed_at", null)
        .limit(1);
      if (findError) throw findError;
      const disbursementId = rows?.[0]?.id;
      if (!disbursementId) throw new Error("This loan has no disbursement to reverse.");

      const { data, error } = await supabase.rpc("mf_reverse_disbursement", {
        p_disbursement_id: disbursementId,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Disbursement reversed — the loan is back to pending disbursement");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The reversal was refused")),
  });



  /** Lifecycle exception: write off an active loan (server-posted). */
  const writeOff = useMutation({
    mutationFn: async (input: { loanId: string; writtenOffOn: string; reason: string }) => {
      const { data, error } = await supabase.rpc("mf_write_off_loan", {
        p_loan_id: input.loanId,
        p_written_off_on: input.writtenOffOn,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Loan written off and posted to the ledger");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The write-off was refused")),
  });

  /** Lifecycle exception: close a fully repaid loan. */
  const closeLoan = useMutation({
    mutationFn: async (input: { loanId: string; closedOn: string; notes?: string | null }) => {
      const { data, error } = await supabase.rpc("mf_close_loan", {
        p_loan_id: input.loanId,
        p_closed_on: input.closedOn,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Loan closed");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The closure was refused")),
  });

  /**
   * Lifecycle exception: replace an active loan with a successor (top-up or
   * restructure). The server carries forward the outstanding principal, mints
   * the successor in `pending_disbursement` with its own schedule, and settles
   * the predecessor only when the successor is disbursed. History is never
   * edited.
   */
  const reissueLoan = useMutation({
    mutationFn: async (input: {
      loanId: string;
      kind: Exclude<MfLoanLineageKind, "new">;
      additionalPrincipal?: number | null;
      termInstallments?: number | null;
      interestRate?: number | null;
      expectedDisbursementDate?: string | null;
      firstInstallmentDate?: string | null;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("mf_reissue_loan", {
        p_loan_id: input.loanId,
        p_kind: input.kind,
        p_additional_principal: input.additionalPrincipal ?? 0,
        p_term_installments: input.termInstallments ?? undefined,
        p_interest_rate: input.interestRate ?? undefined,
        p_expected_disbursement_date: input.expectedDisbursementDate ?? undefined,
        p_first_installment_date: input.firstInstallmentDate ?? undefined,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_id, input) => {
      invalidate();
      toast.success(
        input.kind === "topup"
          ? "Top-up loan created — disburse it to settle the original"
          : "Restructured loan created — disburse it to settle the original",
      );
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The reissue was refused")),
  });

  return {
    loans: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    createFromApplication,
    disburse,
    reverseDisbursement,
    writeOff,
    closeLoan,
    reissueLoan,
    businessId,
  };
}


/** Penalty charged / paid / outstanding for one installment. */
export interface MfLoanPenaltyRow {
  loan_id: string;
  installment_no: number;
  penalty_charged: number;
  penalty_paid: number;
  penalty_outstanding: number;
}

/** Contractual schedule, penalty position and event history for one loan. */
export function useMfLoanSchedule(loanId?: string) {

  const schedule = useQuery({
    queryKey: ["mf-loan-schedule", loanId],
    queryFn: async () => {
      if (!loanId) return [] as MfLoanScheduleRow[];
      const { data, error } = await supabase
        .from("mf_loan_schedule_display")
        .select(
          "id,loan_id,installment_no,due_date,opening_balance,principal_due,interest_due,fees_due,total_due,closing_balance,is_grace,principal_component,interest_component,interest_recognised,is_interest_recognised",
        )
        .eq("loan_id", loanId)
        .order("installment_no");
      if (error) throw error;
      return (data ?? []) as unknown as MfLoanScheduleRow[];

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

  // Penalty position per installment. Server-owned view — never derived here.
  const penalties = useQuery({
    queryKey: ["mf-loan-penalty-status", loanId],
    queryFn: async () => {
      if (!loanId) return [] as MfLoanPenaltyRow[];
      const { data, error } = await supabase
        .from("mf_loan_penalty_status")
        .select("loan_id,installment_no,penalty_charged,penalty_paid,penalty_outstanding")
        .eq("loan_id", loanId)
        .order("installment_no");
      if (error) throw error;
      return (data ?? []) as unknown as MfLoanPenaltyRow[];
    },
    enabled: !!loanId,
  });

  return {
    schedule: schedule.data ?? [],
    events: events.data ?? [],
    penalties: penalties.data ?? [],
    isLoading: schedule.isLoading,
    error: schedule.error as Error | null,
  };
}


/**
 * One fee line as the server resolves it for a loan. The browser never
 * computes a fee — this is a read-only preview of `mf_compute_loan_fees`.
 */
export interface MfLoanFeeLine {
  name: string;
  basis: "percent_of_principal" | "fixed";
  value: number;
  collection:
    | "deducted_from_disbursement"
    | "added_to_first_installment"
    | "paid_at_disbursement";
  amount: number;
}

/** Server-resolved fee preview for a loan (used before disbursement). */
export function useMfLoanFeePreview(loanId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["mf-loan-fee-preview", loanId ?? null],
    queryFn: async () => {
      if (!loanId) return [] as MfLoanFeeLine[];
      const { data, error } = await supabase.rpc("mf_compute_loan_fees", {
        p_loan_id: loanId,
      });
      if (error) throw error;
      return ((data ?? []) as unknown as MfLoanFeeLine[]).map((f) => ({
        ...f,
        value: Number(f.value),
        amount: Number(f.amount),
      }));
    },
    enabled: !!loanId,
  });

  const fees = query.data ?? [];
  const totalFor = (collection: MfLoanFeeLine["collection"]) =>
    fees.filter((f) => f.collection === collection).reduce((sum, f) => sum + f.amount, 0);

  return {
    fees,
    /** Netted off the payout: the client takes home less cash. */
    deductedTotal: totalFor("deducted_from_disbursement"),
    /** Handed over in cash by the client at the payout desk. */
    clientPaidTotal: totalFor("paid_at_disbursement"),
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

/**
 * The whole term's interest when the loan's frozen terms say it is taken at
 * payout, otherwise zero. Resolved by `mf_loan_upfront_interest` — the browser
 * never prices interest itself.
 */
export function useMfLoanUpfrontInterest(loanId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["mf-loan-upfront-interest", loanId ?? null],
    enabled: !!loanId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("mf_loan_upfront_interest", {
        p_loan_id: loanId!,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
  });

  return {
    upfrontInterest: query.data ?? 0,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

/* ------------------------------------------------------------------ */
/* Payout-desk photo — identity evidence for one disbursement.        */
/* Stored in the private `mf-kyc` bucket under business/loan, and      */
/* linked to the payout row only by the guarded server routine.       */
/* ------------------------------------------------------------------ */

const KYC_BUCKET = "mf-kyc";

export async function attachDisbursementPhoto(input: {
  businessId: string;
  loanId: string;
  disbursementId: string;
  file: Blob;
}): Promise<string> {
  const path = `${input.businessId}/${input.loanId}/payout-${input.disbursementId}.jpg`;
  const { error: upErr } = await supabase.storage
    .from(KYC_BUCKET)
    .upload(path, input.file, {
      upsert: false,
      contentType: "image/jpeg",
      cacheControl: "0",
    });
  if (upErr) throw upErr;

  const { error } = await supabase.rpc("mf_attach_disbursement_photo", {
    p_disbursement_id: input.disbursementId,
    p_path: path,
  });
  if (error) throw error;
  return path;
}

export interface MfLoanDisbursementRow {
  id: string;
  loan_id: string;
  disbursed_on: string;
  amount: number;
  method: string;
  reference: string | null;
  received_by_name: string | null;
  net_amount: number | null;
  fees_deducted: number | null;
  /** Interest taken out of this payout, if the terms collect it upfront. */
  upfront_interest: number | null;
  /** Fee the client handed over in cash, never netted off the payout. */
  fees_paid_by_client: number | null;
  reversed_at: string | null;
  payout_photo_path: string | null;
}

/** The live (non-reversed) payout record for a loan, if any. */
export function useMfLoanDisbursement(loanId: string | null | undefined) {
  return useQuery({
    queryKey: ["mf-loan-disbursement", loanId ?? null],
    enabled: !!loanId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_loan_disbursements")
        .select(
          "id,loan_id,disbursed_on,amount,method,reference,received_by_name,net_amount,fees_deducted,upfront_interest,fees_paid_by_client,reversed_at,payout_photo_path",
        )
        .eq("loan_id", loanId!)
        .is("reversed_at", null)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as MfLoanDisbursementRow | null;
    },
  });
}
