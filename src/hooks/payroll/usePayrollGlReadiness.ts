import { normalizeError } from "@/services/resilience";
/**
 * usePayrollGlReadiness — proactive GL-mapping readiness check.
 *
 * Backed by the SECURITY DEFINER `payroll_gl_readiness` SQL function which
 * returns one row per required mapping key (core + per-active-statutory-rule)
 * with `is_mapped`, `suggested_account_id`, and `suggested_account_label`.
 *
 * Exposes:
 *   - `rows` / `missing` / `isReady`
 *   - `applyAll()` — bulk-apply all suggested mappings via
 *     `payroll_apply_proposed_mappings`
 *   - `applyOne(setting_key, account_id)` — apply a single mapping
 *   - `createAndMap(...)` — create a new chart-of-accounts row and map it
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { toast } from "sonner";

export interface PayrollGlReadinessRow {
  setting_key: string;
  label: string;
  rule_code: string | null;
  /**
   * Semantic bucket for the required account.
   *   `core` / `employee_payable` / `employer_expense` / `employer_payable`
   *     — flat `default_account_settings` keys (Payroll GL Mapping surface).
   *   `loan_receivable` / `interest_income`
   *     — loan-type-scoped mappings owned by Loan Types settings. Not part of
   *       `default_account_settings`; the UI must route these to the Loan
   *       Types page rather than the generic mapping fixer.
   */
  kind:
    | "core"
    | "employee_payable"
    | "employer_expense"
    | "employer_payable"
    | "loan_receivable"
    | "interest_income";
  required_account_type: "asset" | "liability" | "equity" | "income" | "expense";
  is_mapped: boolean;
  suggested_account_id: string | null;
  suggested_account_label: string | null;
}

export function usePayrollGlReadiness() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const qc = useQueryClient();

  const queryKey = ["payroll-gl-readiness", currentOrg?.id, currentBusiness?.id];

  const query = useQuery({
    queryKey,
    enabled: !!currentOrg?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<PayrollGlReadinessRow[]> => {
      const { data, error } = await (supabase as any).rpc("payroll_gl_readiness", {
        _org_id: currentOrg!.id,
        _business_id: currentBusiness?.id ?? null,
      });
      if (error) throw error;
      return (data || []) as PayrollGlReadinessRow[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ["app-setup-status", currentOrg?.id] });
    qc.invalidateQueries({ queryKey: ["payroll-runs"] });
    qc.invalidateQueries({ queryKey: ["employee-payroll-readiness"] });
    qc.invalidateQueries({ queryKey: ["payroll-account-mappings"] });
  };

  const applyAll = useMutation({
    mutationFn: async (
      pairs: { setting_key: string; account_id: string }[],
    ) => {
      if (!currentOrg?.id) throw new Error("Select an organization first");
      const { data, error } = await (supabase as any).rpc(
        "payroll_apply_proposed_mappings",
        {
          _org_id: currentOrg.id,
          _business_id: currentBusiness?.id ?? null,
          _accept: pairs,
          _branch_id: currentBranch?.id ?? null,
        },
      );
      if (error) throw error;
      return data as number;
    },
    onSuccess: (n) => {
      toast.success(`${n} mapping${n === 1 ? "" : "s"} applied`);
      invalidate();
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Could not apply mappings"),
  });

  const applyOne = useMutation({
    mutationFn: async (p: { setting_key: string; account_id: string }) => {
      return applyAll.mutateAsync([p]);
    },
  });

  const createAndMap = useMutation({
    mutationFn: async (p: {
      setting_key: string;
      name: string;
      account_type: "asset" | "liability" | "equity" | "income" | "expense";
    }) => {
      if (!currentOrg?.id) throw new Error("Select an organization first");
      const { data, error } = await (supabase as any).rpc(
        "payroll_create_and_map_account",
        {
          _org_id: currentOrg.id,
          _business_id: currentBusiness?.id ?? null,
          _setting_key: p.setting_key,
          _name: p.name,
          _account_type: p.account_type,
          _branch_id: currentBranch?.id ?? null,
        },
      );
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success("Account created & mapped");
      invalidate();
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Could not create account"),
  });

  const rows = query.data ?? [];
  const missing = rows.filter((r) => !r.is_mapped);
  const suggestedPairs = missing
    .filter((r) => !!r.suggested_account_id)
    .map((r) => ({ setting_key: r.setting_key, account_id: r.suggested_account_id! }));

  return {
    rows,
    missing,
    suggestedPairs,
    isReady: missing.length === 0,
    isLoading: query.isLoading,
    refetch: query.refetch,
    applyAll,
    applyOne,
    createAndMap,
  };
}

/* ---------------------------------------------------------------------------
 * Cross-component event bus for the missing-mappings dialog.
 * post-payroll-gl returns a structured `missing_mappings` body; the GL hook
 * dispatches this event so a globally-mounted <MissingMappingsDialog/> opens
 * with the exact list, regardless of where the post was triggered from.
 * ------------------------------------------------------------------------- */
export interface MissingMappingsEventDetail {
  message: string;
  missing: Array<{
    setting_key: string;
    label: string;
    rule_code: string | null;
    kind: PayrollGlReadinessRow["kind"];
    suggested_account_id: string | null;
    suggested_account_label: string | null;
  }>;
  action?: { label: string; to: string };
}

export const MISSING_MAPPINGS_EVENT = "payroll:missing-mappings";

export function dispatchMissingMappings(detail: MissingMappingsEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MISSING_MAPPINGS_EVENT, { detail }));
}