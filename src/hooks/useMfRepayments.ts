/**
 * Microfinance repayments, allocation and derived arrears (C7).
 *
 * All money maths is server-side: `mf_record_repayment` allocates against the
 * oldest open installment following the configured allocation order, and
 * `mf_reverse_repayment` writes an append-only reversal. Balances, days past
 * due and overdue amounts come from the `mf_loan_balances` /
 * `mf_loan_installment_status` views. React only collects intent and renders.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export const MF_REPAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "cheque", label: "Cheque" },
] as const;

export interface MfRepayment {
  id: string;
  business_id: string;
  branch_id: string | null;
  batch_id: string | null;
  loan_id: string;
  client_id: string;
  receipt_number: string;
  paid_on: string;
  amount: number;
  method: string;
  reference: string | null;
  status: string;
  reversal_reason: string | null;
  reversed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface MfRepaymentBatch {
  id: string;
  business_id: string;
  branch_id: string | null;
  group_id: string | null;
  batch_number: string;
  collected_on: string;
  status: string;
  notes: string | null;
  created_at: string;
}

export interface MfLoanBalance {
  loan_id: string;
  business_id: string;
  branch_id: string | null;
  client_id: string;
  loan_officer_id: string | null;
  loan_number: string;
  status: string;
  currency_code: string;
  principal: number;
  principal_outstanding: number;
  interest_outstanding: number;
  fees_outstanding: number;
  total_outstanding: number;
  total_contractual: number;
  amount_overdue: number;
  days_past_due: number;
  next_due_date: string | null;
}

export interface MfRepaymentAllocation {
  id: string;
  repayment_id: string;
  loan_id: string;
  installment_no: number;
  component: string;
  amount: number;
}

const REPAYMENT_SELECT =
  "id,business_id,branch_id,batch_id,loan_id,client_id,receipt_number,paid_on,amount,method,reference,status,reversal_reason,reversed_at,notes,created_at";

/**
 * Supabase refusals arrive as plain objects ({ message, details, hint, code }),
 * not Error instances, so reading `.message` off an Error alone rendered
 * "[object Object]" in the toast. Read the message from either shape.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown };
    const parts = [e.message, e.details, e.hint].filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    if (parts.length) return parts.join(" — ");
  }
  return typeof error === "string" ? error : "";
}

function friendly(error: unknown, fallback: string): string {
  const msg = errorMessage(error);
  if (/row-level security/i.test(msg)) {
    return "You do not have permission to perform this action.";
  }
  if (/closed|locked/i.test(msg) && /period/i.test(msg)) {
    return `${msg} Reopen the accounting month, or date the payment inside an open month.`;
  }
  return msg || fallback;
}

/** Receipts for the institution, with capture and reversal events. */
export function useMfRepayments(options?: { loanId?: string; batchId?: string }) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const loanId = options?.loanId;
  const batchId = options?.batchId;

  const query = useQuery({
    queryKey: ["mf-repayments", businessId, loanId ?? null, batchId ?? null],
    queryFn: async () => {
      if (!businessId) return [] as MfRepayment[];
      let q = supabase
        .from("mf_repayments")
        .select(REPAYMENT_SELECT)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (loanId) q = q.eq("loan_id", loanId);
      if (batchId) q = q.eq("batch_id", batchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfRepayment[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-repayments"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loan-balances"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loans"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loan-schedule"] });
  };

  /** Capture a receipt; the server allocates it. */
  const record = useMutation({
    mutationFn: async (input: {
      loanId: string;
      paidOn: string;
      amount: number;
      method: string;
      reference?: string | null;
      batchId?: string | null;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("mf_record_repayment", {
        p_loan_id: input.loanId,
        p_paid_on: input.paidOn,
        p_amount: input.amount,
        p_method: input.method,
        p_reference: input.reference ?? null,
        p_batch_id: input.batchId ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Payment recorded and allocated");
    },
    onError: (e) => toast.error(friendly(e, "The payment was refused")),
  });

  /** Append-only reversal of a posted receipt. */
  const reverse = useMutation({
    mutationFn: async (input: { repaymentId: string; reason: string }) => {
      const { data, error } = await supabase.rpc("mf_reverse_repayment", {
        p_repayment_id: input.repaymentId,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Payment reversed");
    },
    onError: (e) => toast.error(friendly(e, "The reversal was refused")),
  });

  return {
    repayments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    record,
    reverse,
    businessId,
  };
}

/** Collection batches (one per meeting / collection round). */
export function useMfRepaymentBatches() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-repayment-batches", businessId],
    queryFn: async () => {
      if (!businessId) return [] as MfRepaymentBatch[];
      const { data, error } = await supabase
        .from("mf_repayment_batches")
        .select("id,business_id,branch_id,group_id,batch_number,collected_on,status,notes,created_at")
        .eq("business_id", businessId)
        .order("collected_on", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as MfRepaymentBatch[];
    },
    enabled: !!businessId,
  });

  const openBatch = useMutation({
    mutationFn: async (input: {
      collectedOn: string;
      groupId?: string | null;
      branchId?: string | null;
      notes?: string | null;
    }) => {
      if (!businessId) throw new Error("No institution selected");
      const stamp = new Date();
      const batchNumber = `BATCH-${input.collectedOn.replace(/-/g, "")}-${String(
        stamp.getHours(),
      ).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}${String(
        stamp.getSeconds(),
      ).padStart(2, "0")}`;
      const { data, error } = await supabase
        .from("mf_repayment_batches")
        .insert({
          business_id: businessId,
          branch_id: input.branchId ?? null,
          group_id: input.groupId ?? null,
          batch_number: batchNumber,
          collected_on: input.collectedOn,
          notes: input.notes ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-repayment-batches"] });
      toast.success("Collection batch opened");
    },
    onError: (e) => toast.error(friendly(e, "Could not open the batch")),
  });

  const closeBatch = useMutation({
    mutationFn: async (batchId: string) => {
      const { error } = await supabase
        .from("mf_repayment_batches")
        .update({ status: "closed" })
        .eq("id", batchId);
      if (error) throw error;
      return batchId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-repayment-batches"] });
      toast.success("Batch closed");
    },
    onError: (e) => toast.error(friendly(e, "Could not close the batch")),
  });

  return {
    batches: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    openBatch,
    closeBatch,
  };
}

/** Server-derived balances, arrears and days past due. */
export function useMfLoanBalances(options?: { onlyArrears?: boolean; officerId?: string }) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const query = useQuery({
    queryKey: ["mf-loan-balances", businessId, options?.onlyArrears ?? false, options?.officerId ?? null],
    queryFn: async () => {
      if (!businessId) return [] as MfLoanBalance[];
      let q = supabase
        .from("mf_loan_balances")
        .select("*")
        .eq("business_id", businessId)
        .order("days_past_due", { ascending: false });
      if (options?.onlyArrears) q = q.gt("amount_overdue", 0);
      if (options?.officerId) q = q.eq("loan_officer_id", options.officerId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfLoanBalance[];
    },
    enabled: !!businessId,
  });

  return {
    balances: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

/** Allocation breakdown for one receipt. */
export function useMfRepaymentAllocations(repaymentId?: string) {
  const query = useQuery({
    queryKey: ["mf-repayment-allocations", repaymentId ?? null],
    queryFn: async () => {
      if (!repaymentId) return [] as MfRepaymentAllocation[];
      const { data, error } = await supabase
        .from("mf_repayment_allocations")
        .select("id,repayment_id,loan_id,installment_no,component,amount")
        .eq("repayment_id", repaymentId)
        .order("installment_no", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MfRepaymentAllocation[];
    },
    enabled: !!repaymentId,
  });

  return {
    allocations: query.data ?? [],
    isLoading: query.isLoading,
  };
}
