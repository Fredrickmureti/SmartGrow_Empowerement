/**
 * Microfinance loan applications, assessments and decisions (C5).
 *
 * The pipeline is event-driven: the UI asks for a transition, and the database
 * guard decides whether it is legal, who may decide, that an assessment exists,
 * and that the approved terms sit inside the product version's band. No status
 * maths, authority rule or eligibility check is trusted to React.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

export type MfApplicationStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "ready_for_disbursement"
  | "disbursed"
  | "cancelled";

export const MF_APPLICATION_STATUSES: MfApplicationStatus[] = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "ready_for_disbursement",
  "disbursed",
  "cancelled",
];

export const MF_APPLICATION_STATUS_LABELS: Record<MfApplicationStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  ready_for_disbursement: "Loan created — awaiting disbursement",
  disbursed: "Disbursed",
  cancelled: "Cancelled",
};

/**
 * Transitions the database guard accepts — mirrored only to shape the UI.
 *
 * `ready_for_disbursement` and `disbursed` are set by the loan-creation and
 * disbursement events, not by an operator flipping a status.
 */
export const MF_APPLICATION_TRANSITIONS: Record<MfApplicationStatus, MfApplicationStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["under_review", "draft", "cancelled"],
  under_review: ["approved", "rejected", "cancelled"],
  approved: ["cancelled"],
  rejected: [],
  ready_for_disbursement: ["cancelled"],
  disbursed: [],
  cancelled: [],
};

export const MF_APPLICATION_OPEN_STATUSES: MfApplicationStatus[] = [
  "draft",
  "submitted",
  "under_review",
];

export type MfAssessmentRecommendation = "recommend" | "decline" | "refer";

export const MF_ASSESSMENT_RECOMMENDATIONS: MfAssessmentRecommendation[] = [
  "recommend",
  "decline",
  "refer",
];

export interface MfLoanApplication {
  id: string;
  business_id: string;
  branch_id: string;
  application_number: string;
  client_id: string;
  group_id: string | null;
  product_id: string;
  product_version_id: string | null;
  loan_officer_id: string | null;
  requested_amount: number;
  requested_term_installments: number;
  purpose: string | null;
  status: MfApplicationStatus;
  submitted_at: string | null;
  submitted_by: string | null;
  review_started_at: string | null;
  approved_amount: number | null;
  approved_term_installments: number | null;
  decision_by: string | null;
  decision_at: string | null;
  decision_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MfApplicationAssessment {
  id: string;
  business_id: string;
  application_id: string;
  assessed_by: string;
  assessed_at: string;
  visit_date: string;
  visit_location: string | null;
  business_verified: boolean;
  monthly_income: number;
  monthly_expenses: number;
  existing_obligations: number;
  collateral_description: string | null;
  character_notes: string | null;
  recommended_amount: number | null;
  recommended_term_installments: number | null;
  recommendation: MfAssessmentRecommendation;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MfLoanApplicationInput {
  branch_id: string;
  /** Assigned server-side by the numbering trigger; never sent on create. */
  application_number?: string;
  client_id: string;
  group_id?: string | null;
  product_id: string;
  product_version_id?: string | null;
  loan_officer_id?: string | null;
  requested_amount: number;
  requested_term_installments: number;
  purpose?: string | null;
}

export type MfAssessmentInput = Omit<
  MfApplicationAssessment,
  "id" | "business_id" | "assessed_by" | "created_at" | "updated_at" | "assessed_at"
> & { assessed_at?: string };

const APPLICATION_SELECT =
  "id,business_id,branch_id,application_number,client_id,group_id,product_id,product_version_id,loan_officer_id,requested_amount,requested_term_installments,purpose,status,submitted_at,submitted_by,review_started_at,approved_amount,approved_term_installments,decision_by,decision_at,decision_notes,rejection_reason,created_at,updated_at";

const ASSESSMENT_SELECT =
  "id,business_id,application_id,assessed_by,assessed_at,visit_date,visit_location,business_verified,monthly_income,monthly_expenses,existing_obligations,collateral_description,character_notes,recommended_amount,recommended_term_installments,recommendation,notes,created_at,updated_at";


/** Applications for the institution, newest first. */
export function useMfApplications(options?: {
  status?: MfApplicationStatus | "all" | "open";
  clientId?: string;
}) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const status = options?.status ?? "all";
  const clientId = options?.clientId;

  const query = useQuery({
    queryKey: ["mf-applications", businessId, status, clientId ?? null],
    queryFn: async () => {
      if (!businessId) return [] as MfLoanApplication[];
      let q = supabase
        .from("mf_loan_applications")
        .select(APPLICATION_SELECT)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      if (status === "open") q = q.in("status", MF_APPLICATION_OPEN_STATUSES);
      else if (status !== "all") q = q.eq("status", status);
      if (clientId) q = q.eq("client_id", clientId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfLoanApplication[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-applications"] });
    queryClient.invalidateQueries({ queryKey: ["mf-application-assessments"] });
  };

  const createApplication = useMutation({
    mutationFn: async (input: MfLoanApplicationInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("mf_loan_applications")
        .insert({
          ...input,
          business_id: businessId,
          created_by: auth.user?.id ?? null,
        } as never)
        .select(APPLICATION_SELECT)
        .single();
      if (error) throw error;
      return data as MfLoanApplication;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Application captured");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not create the application")),
  });

  const updateApplication = useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: Partial<MfLoanApplicationInput> & { id: string }) => {
      const { error } = await supabase
        .from("mf_loan_applications")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Application updated");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not update the application")),
  });

  /**
   * Ask the database for a status transition. Every rule that matters —
   * legality, decision authority, assessment presence, product band — is
   * enforced by the guard trigger, so a refusal surfaces as its message.
   */
  const transition = useMutation({
    mutationFn: async (input: {
      id: string;
      to: MfApplicationStatus;
      approved_amount?: number | null;
      approved_term_installments?: number | null;
      product_version_id?: string | null;
      decision_notes?: string | null;
      rejection_reason?: string | null;
    }) => {
      const { id, to, ...rest } = input;
      const { error } = await supabase
        .from("mf_loan_applications")
        .update({ status: to, ...rest })
        .eq("id", id);
      if (error) throw error;
      return to;
    },
    onSuccess: (to) => {
      invalidate();
      toast.success(`Application moved to ${MF_APPLICATION_STATUS_LABELS[to].toLowerCase()}`);
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "That transition was refused")),
  });

  return {
    applications: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    createApplication,
    updateApplication,
    transition,
    businessId,
  };
}

/** Assessments recorded against one application. */
export function useMfApplicationAssessments(applicationId?: string) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-application-assessments", applicationId],
    queryFn: async () => {
      if (!applicationId) return [] as MfApplicationAssessment[];
      const { data, error } = await supabase
        .from("mf_application_assessments")
        .select(ASSESSMENT_SELECT)
        .eq("application_id", applicationId)
        .order("assessed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MfApplicationAssessment[];
    },
    enabled: !!applicationId,
  });

  const recordAssessment = useMutation({
    mutationFn: async (input: MfAssessmentInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (!userId) throw new Error("Sign in again to record an assessment");
      const { error } = await supabase.from("mf_application_assessments").insert({
        ...input,
        business_id: businessId,
        assessed_by: userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-application-assessments"] });
      queryClient.invalidateQueries({ queryKey: ["mf-applications"] });
      toast.success("Assessment recorded");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not record the assessment")),
  });

  return {
    assessments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    recordAssessment,
  };
}

/** Next sequential application reference, e.g. APP-0007. */
export function nextApplicationNumber(existing: Array<{ application_number: string }>): string {
  let max = 0;
  for (const row of existing) {
    const m = /(\d+)\s*$/.exec(row.application_number ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `APP-${String(max + 1).padStart(4, "0")}`;
}
