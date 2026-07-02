/**
 * useRecruitment — Turn H hooks for the recruitment pipeline.
 *
 * Surfaces all five tables (job_requisitions, candidates, candidate_applications,
 * interview_feedback, offer_letters) plus the convert_application_to_employee RPC.
 *
 * RLS already restricts reads to org members and writes to HR; UI does not
 * re-enforce here.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type RequisitionStatus = "draft" | "open" | "on_hold" | "filled" | "closed" | "cancelled";
export type ApplicationStage = "applied" | "screen" | "interview" | "assessment" | "offer" | "hired" | "rejected" | "withdrawn";
export type InterviewRecommendation = "strong_no" | "no" | "maybe" | "yes" | "strong_yes";
export type OfferStatus = "draft" | "sent" | "accepted" | "declined" | "withdrawn" | "rescinded";

export interface JobRequisition {
  id: string;
  organization_id: string;
  business_id: string | null;
  title: string;
  job_position_id: string | null;
  department_id: string | null;
  work_location_id: string | null;
  hiring_manager_id: string | null;
  headcount: number;
  status: RequisitionStatus;
  employment_type: string | null;
  min_salary: number | null;
  max_salary: number | null;
  currency: string | null;
  description: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Candidate {
  id: string;
  organization_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  linkedin_url: string | null;
  resume_url: string | null;
  current_title: string | null;
  current_company: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
}

export interface CandidateApplication {
  id: string;
  organization_id: string;
  candidate_id: string;
  requisition_id: string;
  stage: ApplicationStage;
  rejection_reason: string | null;
  applied_at: string;
  stage_updated_at: string;
  converted_employee_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InterviewFeedback {
  id: string;
  application_id: string;
  reviewer_user_id: string;
  stage_name: string | null;
  rating: number | null;
  recommendation: InterviewRecommendation | null;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  created_at: string;
}

export interface OfferLetter {
  id: string;
  application_id: string;
  status: OfferStatus;
  base_salary: number | null;
  currency: string | null;
  bonus_target: number | null;
  start_date: string | null;
  expires_at: string | null;
  sent_at: string | null;
  decision_at: string | null;
  letter_body: string | null;
  notes: string | null;
  created_at: string;
}

export function useRequisitions() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: requisitions = [], isLoading } = useQuery({
    queryKey: ["requisitions", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase.from("job_requisitions").select("*").eq("organization_id", currentOrg.id);
      if (currentBusiness?.id) q = q.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as JobRequisition[];
    },
    enabled: !!currentOrg?.id,
  });

  const createRequisition = useMutation({
    mutationFn: async (input: Partial<JobRequisition> & { title: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("job_requisitions")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          status: "draft",
          headcount: 1,
          created_by: u?.user?.id ?? "",
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); toast.success("Requisition created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateRequisition = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<JobRequisition> }) => {
      const { error } = await supabase.from("job_requisitions").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); toast.success("Requisition updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteRequisition = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("job_requisitions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requisitions"] }); toast.success("Requisition removed"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { requisitions, isLoading, createRequisition, updateRequisition, deleteRequisition };
}

export function useCandidates() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ["candidates", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("candidates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Candidate[];
    },
    enabled: !!currentOrg?.id,
  });

  const createCandidate = useMutation({
    mutationFn: async (input: Partial<Candidate> & { full_name: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("candidates")
        .insert({
          organization_id: currentOrg.id,
          tags: [],
          created_by: u?.user?.id,
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["candidates"] }); toast.success("Candidate added"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { candidates, isLoading, createCandidate };
}

export function useApplications(requisitionId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: applications = [], isLoading } = useQuery({
    queryKey: ["applications", currentOrg?.id, requisitionId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase.from("candidate_applications").select("*").eq("organization_id", currentOrg.id);
      if (requisitionId) q = q.eq("requisition_id", requisitionId);
      const { data, error } = await q.order("applied_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CandidateApplication[];
    },
    enabled: !!currentOrg?.id,
  });

  const createApplication = useMutation({
    mutationFn: async (input: { candidate_id: string; requisition_id: string; stage?: ApplicationStage }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("candidate_applications")
        .insert({
          organization_id: currentOrg.id,
          stage: input.stage ?? "applied",
          candidate_id: input.candidate_id,
          requisition_id: input.requisition_id,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["applications"] }); toast.success("Application created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateStage = useMutation({
    mutationFn: async ({ id, stage, rejection_reason }: { id: string; stage: ApplicationStage; rejection_reason?: string }) => {
      const { error } = await supabase
        .from("candidate_applications")
        .update({ stage, rejection_reason: rejection_reason ?? null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["applications"] }); toast.success("Stage updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const convertToEmployee = useMutation({
    mutationFn: async (input: { application_id: string; payload: Record<string, unknown> }) => {
      const { data, error } = await supabase.rpc("convert_application_to_employee", {
        p_application_id: input.application_id,
        p_employee_payload: input.payload as any,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["requisitions"] });
      qc.invalidateQueries({ queryKey: ["employees"] });
      toast.success("Candidate hired and employee record created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { applications, isLoading, createApplication, updateStage, convertToEmployee };
}

export function useInterviewFeedback(applicationId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: feedback = [], isLoading } = useQuery({
    queryKey: ["interview-feedback", applicationId],
    queryFn: async () => {
      if (!applicationId) return [];
      const { data, error } = await supabase
        .from("interview_feedback")
        .select("*")
        .eq("application_id", applicationId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as InterviewFeedback[];
    },
    enabled: !!applicationId,
  });

  const createFeedback = useMutation({
    mutationFn: async (input: Partial<InterviewFeedback> & { application_id: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const userId = u?.user?.id;
      if (!userId) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("interview_feedback")
        .insert({
          organization_id: currentOrg.id,
          reviewer_user_id: userId,
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interview-feedback"] }); toast.success("Feedback saved"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { feedback, isLoading, createFeedback };
}

export function useOffers(applicationId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: offers = [], isLoading } = useQuery({
    queryKey: ["offers", applicationId],
    queryFn: async () => {
      if (!applicationId) return [];
      const { data, error } = await supabase
        .from("offer_letters")
        .select("*")
        .eq("application_id", applicationId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as OfferLetter[];
    },
    enabled: !!applicationId,
  });

  const createOffer = useMutation({
    mutationFn: async (input: Partial<OfferLetter> & { application_id: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: u } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("offer_letters")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          status: "draft",
          created_by: u?.user?.id ?? "",
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["offers"] }); qc.invalidateQueries({ queryKey: ["applications"] }); toast.success("Offer created"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateOffer = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<OfferLetter> }) => {
      const { error } = await supabase.from("offer_letters").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["offers"] }); toast.success("Offer updated"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { offers, isLoading, createOffer, updateOffer };
}
