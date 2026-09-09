/**
 * Microfinance arrears and collections (C7b).
 *
 * Arrears, days past due and PAR are read from the server-derived
 * `mf_loan_arrears` / `mf_par_summary` views — React never derives them.
 * Collection activities are append-only and attributed to the acting officer;
 * row-level security scopes every read to the caller's portfolio.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

export const MF_ACTIVITY_TYPES = [
  { value: "call", label: "Phone call" },
  { value: "visit", label: "Field visit" },
  { value: "sms", label: "SMS" },
  { value: "letter", label: "Letter" },
  { value: "promise_to_pay", label: "Promise to pay" },
  { value: "field_follow_up", label: "Field follow-up" },
  { value: "legal_notice", label: "Legal notice" },
  { value: "other", label: "Other" },
] as const;

export const MF_ACTIVITY_OUTCOMES = [
  { value: "contacted", label: "Contacted" },
  { value: "not_reached", label: "Not reached" },
  { value: "promised", label: "Promised to pay" },
  { value: "paid", label: "Paid in full" },
  { value: "partial", label: "Partial payment" },
  { value: "refused", label: "Refused" },
  { value: "disputed", label: "Disputed" },
  { value: "unreachable", label: "Unreachable" },
  { value: "other", label: "Other" },
] as const;

export interface MfLoanArrears {
  business_id: string;
  branch_id: string | null;
  loan_officer_id: string | null;
  client_id: string;
  loan_id: string;
  loan_number: string;
  installment_no: number;
  due_date: string;
  principal_due: number;
  interest_due: number;
  fees_due: number;
  total_due: number;
  total_paid: number;
  balance_due: number;
  arrears_amount: number;
  days_past_due: number;
}

export interface MfParSummary {
  business_id: string;
  branch_id: string | null;
  loan_officer_id: string | null;
  loan_count: number;
  portfolio_outstanding: number;
  /** Outstanding at risk. Server-coalesced to 0 — never null. */
  par_1: number;
  par_30: number;
  par_90: number;
  /** Percent of this row's outstanding at risk, computed by the view. */
  par_1_ratio: number;
  par_30_ratio: number;
  par_90_ratio: number;
}


export interface MfCollectionActivity {
  id: string;
  business_id: string;
  branch_id: string | null;
  loan_id: string;
  client_id: string;
  officer_id: string;
  activity_type: string;
  activity_at: string;
  outcome: string | null;
  promise_amount: number | null;
  promise_date: string | null;
  amount_collected: number | null;
  notes: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
}

export interface MfCollectionActivityInput {
  loanId: string;
  clientId: string;
  branchId?: string | null;
  activityType: string;
  activityAt?: string;
  outcome?: string | null;
  promiseAmount?: number | null;
  promiseDate?: string | null;
  amountCollected?: number | null;
  notes?: string | null;
}

export function useMfArrears() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-loan-arrears", businessId],
    queryFn: async () => {
      if (!businessId) return [] as MfLoanArrears[];
      const { data, error } = await supabase
        .from("mf_loan_arrears")
        .select("*")
        .eq("business_id", businessId)
        .order("days_past_due", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as MfLoanArrears[];
    },
    enabled: !!businessId,
  });

  return {
    arrears: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export function useMfParSummary() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-par-summary", businessId],
    queryFn: async () => {
      if (!businessId) return [] as MfParSummary[];
      const { data, error } = await supabase
        .from("mf_par_summary")
        .select("*")
        .eq("business_id", businessId);
      if (error) throw error;
      return (data ?? []) as unknown as MfParSummary[];
    },
    enabled: !!businessId,
  });

  return {
    par: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export function useMfCollectionActivities(loanId?: string) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-collection-activities", businessId, loanId ?? "all"],
    queryFn: async () => {
      if (!businessId) return [] as MfCollectionActivity[];
      let request = supabase
        .from("mf_collection_activities")
        .select("*")
        .eq("business_id", businessId)
        .order("activity_at", { ascending: false })
        .limit(500);
      if (loanId) request = request.eq("loan_id", loanId);
      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []) as unknown as MfCollectionActivity[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-collection-activities"] });
  };

  const logActivity = useMutation({
    mutationFn: async (input: MfCollectionActivityInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { data: auth } = await supabase.auth.getUser();
      const officerId = auth.user?.id;
      if (!officerId) throw new Error("You must be signed in to log an activity");

      const { error } = await supabase.from("mf_collection_activities").insert({
        business_id: businessId,
        branch_id: input.branchId ?? null,
        loan_id: input.loanId,
        client_id: input.clientId,
        officer_id: officerId,
        activity_type: input.activityType,
        activity_at: input.activityAt ?? new Date().toISOString(),
        outcome: input.outcome ?? null,
        promise_amount: input.promiseAmount ?? null,
        promise_date: input.promiseDate ?? null,
        amount_collected: input.amountCollected ?? null,
        notes: input.notes ?? null,
        created_by: officerId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Collection activity recorded");
    },
    onError: (error) => toast.error(lendingErrorMessage(error, "That request was refused")),
  });

  const cancelActivity = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase
        .from("mf_collection_activities")
        .update({ cancelled_at: new Date().toISOString(), cancellation_reason: reason })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Activity cancelled");
    },
    onError: (error) => toast.error(lendingErrorMessage(error, "That request was refused")),
  });

  return {
    activities: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    logActivity,
    cancelActivity,
  };
}

/**
 * Penalty accrual. The server raises one penalty charge per overdue
 * installment using the loan's own penalty rate and basis; running it twice
 * for the same date is a no-op. React never computes a penalty amount.
 */
export function useMfAccruePenalties() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (asOf?: string) => {
      if (!businessId) throw new Error("No institution selected");
      const { data, error } = await supabase.rpc("mf_accrue_penalties", {
        p_business_id: businessId,
        p_as_of: asOf ?? new Date().toISOString().slice(0, 10),
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["mf-loan-arrears"] });
      queryClient.invalidateQueries({ queryKey: ["mf-loan-balances"] });
      queryClient.invalidateQueries({ queryKey: ["mf-loan-charges"] });
      toast.success(
        count > 0
          ? `${count} penalty charge${count === 1 ? "" : "s"} raised`
          : "No new penalties to raise",
      );
    },
    onError: (error) => toast.error(lendingErrorMessage(error, "That request was refused")),
  });
}
