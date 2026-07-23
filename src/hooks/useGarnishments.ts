/**
 * useGarnishments — Turn F admin hook for `legal_orders_records`
 * (formerly `employee_garnishments`).
 *
 * Court-ordered/regulatory wage deductions. RLS already restricts to org HR.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type GarnishmentKind =
  | "child_support"
  | "tax_levy"
  | "court_order"
  | "student_loan"
  | "creditor"
  | "wage_assignment"
  | "other";

export type GarnishmentCapRule =
  | "fixed_amount"
  | "percent_disposable"
  | "lesser_of_fixed_or_pct";

export type GarnishmentStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "active"
  | "suspended"
  | "satisfied"
  | "released"
  | "expired"
  | "terminated_unsatisfied";

export type GarnishmentTransitionAction =
  | "submit"
  | "approve"
  | "reject"
  | "activate"
  | "suspend"
  | "resume"
  | "mark_satisfied"
  | "release"
  | "expire"
  | "terminate_unsatisfied"
  | "adjust_balance"
  | "attach_evidence"
  | "note";

export interface GarnishmentLifecycleEvent {
  id: string;
  garnishment_id: string;
  event: GarnishmentTransitionAction;
  from_status: GarnishmentStatus | null;
  to_status: GarnishmentStatus;
  reason_code: string | null;
  reason_text: string | null;
  evidence_document_url: string | null;
  effective_at: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface Garnishment {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  kind: GarnishmentKind;
  priority: number;
  case_reference: string | null;
  authority_id: string | null;
  cap_rule: GarnishmentCapRule;
  fixed_amount: number | null;
  percent_of_disposable: number | null;
  total_owed: number | null;
  total_paid: number;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
  status: GarnishmentStatus;
  status_changed_at: string | null;
  status_reason: string | null;
  payee_name: string | null;
  payee_account: string | null;
  payee_bank: string | null;
  payee_reference: string | null;
  document_url: string | null;
  document_filename: string | null;
  minimum_take_home_amount: number | null;
  aggregate_cap_exempt: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function useGarnishments(employeeId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: garnishments = [], isLoading } = useQuery({
    queryKey: ["garnishments", currentOrg?.id, currentBusiness?.id ?? null, employeeId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("employee_garnishments")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("priority", { ascending: true })
        .order("start_date", { ascending: false });
      if (employeeId) q = q.eq("employee_id", employeeId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Garnishment[];
    },
    enabled: !!currentOrg?.id,
  });

  const createGarnishment = useMutation({
    mutationFn: async (
      input: Partial<Garnishment> & {
        employee_id: string;
        kind: GarnishmentKind;
        start_date: string;
        cap_rule: GarnishmentCapRule;
      },
    ) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("employee_garnishments")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          priority: 100,
          is_active: true,
          total_paid: 0,
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      toast.success("Garnishment created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateGarnishment = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Garnishment> }) => {
      const { error } = await supabase.from("employee_garnishments").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      toast.success("Garnishment updated");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteGarnishment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("employee_garnishments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      toast.success("Garnishment removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const transitionGarnishment = useMutation({
    mutationFn: async (args: {
      id: string;
      action: GarnishmentTransitionAction;
      reason_code?: string;
      reason_text?: string;
      evidence_url?: string;
      payload?: Record<string, unknown>;
    }) => {
      const { data, error } = await supabase.rpc("garnishment_transition" as any, {
        p_garnishment_id: args.id,
        p_action: args.action,
        p_reason_code: args.reason_code ?? null,
        p_reason_text: args.reason_text ?? null,
        p_evidence_url: args.evidence_url ?? null,
        p_payload: args.payload ?? {},
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["garnishments"] });
      qc.invalidateQueries({ queryKey: ["garnishment-lifecycle", vars.id] });
      toast.success(`Garnishment ${vars.action.replace(/_/g, " ")}`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return {
    garnishments,
    isLoading,
    createGarnishment,
    updateGarnishment,
    deleteGarnishment,
    transitionGarnishment,
  };
}

export function useGarnishmentLifecycle(garnishmentId: string | null) {
  return useQuery({
    queryKey: ["garnishment-lifecycle", garnishmentId],
    queryFn: async () => {
      if (!garnishmentId) return [];
      const { data, error } = await supabase
        .from("garnishment_lifecycle_events" as any)
        .select("*")
        .eq("garnishment_id", garnishmentId)
        .order("effective_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as GarnishmentLifecycleEvent[];
    },
    enabled: !!garnishmentId,
  });
}

/**
 * Resolved garnishment kinds for the current org.
 * Precedence: tenant override > installed localization pack > platform default.
 * Engines + UI MUST read kinds from here — NEVER hard-code an enum.
 */
export interface ResolvedGarnishmentKind {
  kind: string;
  label: string;
  default_priority: number;
  always_first: boolean;
  counts_toward_aggregate_cap: boolean;
  max_concurrent: number | null;
  employer_fee_amount: number;
  required_identifiers: string[];
  evidence_required: boolean;
  source: "tenant" | "pack" | "platform";
  source_pack_id: string | null;
}

export function useResolvedGarnishmentKinds() {
  const { currentOrg: organization } = useOrganization();
  return useQuery({
    queryKey: ["garnishment-resolved-kinds", organization?.id],
    queryFn: async () => {
      if (!organization?.id) return [] as ResolvedGarnishmentKind[];
      const { data, error } = await (supabase as any).rpc("garnishment_resolve_kinds", {
        p_org_id: organization.id,
      });
      if (error) throw error;
      return (data ?? []) as ResolvedGarnishmentKind[];
    },
    enabled: !!organization?.id,
    staleTime: 5 * 60_000,
  });
}

export interface ResolvedGarnishmentPolicy {
  aggregate_cap_pct: number | null;
  min_take_home_amount: number | null;
  min_take_home_pct: number | null;
  disposable_income_excludes: string[];
  priority_resolution: string;
  protected_earnings_formula_token: string | null;
  source_pack_id: string | null;
  tenant_overrides: {
    aggregate_cap_pct: number | null;
    min_take_home_amount: number | null;
    min_take_home_pct: number | null;
  };
}

export function useResolvedGarnishmentPolicy() {
  const { currentOrg: organization } = useOrganization();
  return useQuery({
    queryKey: ["garnishment-resolved-policy", organization?.id],
    queryFn: async () => {
      if (!organization?.id) return null;
      const { data, error } = await (supabase as any).rpc("garnishment_resolve_policy", {
        p_org_id: organization.id,
      });
      if (error) throw error;
      return data as ResolvedGarnishmentPolicy;
    },
    enabled: !!organization?.id,
    staleTime: 5 * 60_000,
  });
}

