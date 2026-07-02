/**
 * usePayrollReadiness — single source of truth for the "is payroll ready?"
 * question. Backed by `payroll_readiness_summary`, which evaluates the
 * org, business and (optionally) employee scopes in one call and returns
 * a structured JSON payload.
 *
 * The same evaluation engine (`payroll_readiness_*` rules + findings) is
 * used by `assert_payroll_ready_json` inside `compute-payroll`, so the
 * readiness badge and payroll execution can NEVER disagree.
 *
 * Legacy callers still importing the old `("org", subjectId)` signature
 * are supported via overloads, but new code should pass the options
 * object `{ employeeIds, businessId }`.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type PayrollReadinessScope = "org" | "business" | "employee" | "run";

export interface PayrollReadinessBlocker {
  scope: PayrollReadinessScope;
  subject_id: string | null;
  subject_label: string | null;
  rule_code: string;
  rule_name: string;
  reason: string;
  reason_code: string | null;
  remediation_label: string | null;
  remediation_link: string | null;
  missing_fields: string[] | null;
  severity: "block" | "warn" | string;
}

export interface PayrollReadinessSummary {
  is_ready: boolean;
  org_blockers: PayrollReadinessBlocker[];
  business_blockers: PayrollReadinessBlocker[];
  employee_blockers: PayrollReadinessBlocker[];
  run_blockers?: PayrollReadinessBlocker[];
  counts: {
    org: number;
    business: number;
    employee: number;
    employees_evaluated: number;
    run?: number;
  };
  evaluated_at: string;
}

export interface UsePayrollReadinessOptions {
  /** Restrict the employee-scope evaluation to a specific selection. */
  employeeIds?: string[] | null;
  /** Override the business id (defaults to the current business). */
  businessId?: string | null;
  /** Period bounds passed through to rule evaluators that care. */
  periodStart?: string | null;
  periodEnd?: string | null;
  /** When false, the query is disabled. */
  enabled?: boolean;
}

/**
 * Legacy signature kept for callers that still pass `("org", subjectId)`.
 * New callers should pass an options object.
 */
export function usePayrollReadiness(
  scopeOrOptions?: PayrollReadinessScope | UsePayrollReadinessOptions,
  legacySubjectId?: string,
) {
  const opts: UsePayrollReadinessOptions = typeof scopeOrOptions === "object" && scopeOrOptions !== null
    ? scopeOrOptions
    : (() => {
        // Map legacy ("employee", id) → employeeIds=[id]; everything else → no override.
        if (scopeOrOptions === "employee" && legacySubjectId) {
          return { employeeIds: [legacySubjectId] };
        }
        return {};
      })();

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const orgId = currentOrg?.id ?? null;
  const businessId = opts.businessId ?? currentBusiness?.id ?? null;
  const employeeIds = opts.employeeIds ?? null;
  const periodStart = opts.periodStart ?? null;
  const periodEnd = opts.periodEnd ?? null;
  const enabled = opts.enabled !== false && !!orgId;

  const empKey = useMemo(
    () => (employeeIds && employeeIds.length ? [...employeeIds].sort().join(",") : null),
    [employeeIds],
  );

  const queryKey = [
    "payroll-readiness-summary",
    orgId,
    businessId,
    empKey,
    periodStart,
    periodEnd,
  ];

  const summaryQuery = useQuery({
    queryKey,
    enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<PayrollReadinessSummary> => {
      const { data, error } = await (supabase as any).rpc("payroll_readiness_summary", {
        p_org_id: orgId,
        p_business_id: businessId,
        p_employee_ids: employeeIds,
        p_period_start: periodStart,
        p_period_end: periodEnd,
      });
      if (error) throw error;
      return (data ?? {
        is_ready: false,
        org_blockers: [],
        business_blockers: [],
        employee_blockers: [],
        counts: { org: 0, business: 0, employee: 0, employees_evaluated: 0 },
        evaluated_at: new Date().toISOString(),
      }) as PayrollReadinessSummary;
    },
  });

  const evaluate = useMutation({
    // Re-run the summary by invalidating its cache. The summary RPC itself
    // re-evaluates findings on every call, so a refetch is enough.
    mutationFn: async () => {
      if (!orgId) throw new Error("Select an organization first");
      await qc.invalidateQueries({ queryKey: ["payroll-readiness-summary"] });
      const { data, error } = await (supabase as any).rpc("payroll_readiness_summary", {
        p_org_id: orgId,
        p_business_id: businessId,
        p_employee_ids: employeeIds,
        p_period_start: periodStart,
        p_period_end: periodEnd,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Readiness re-evaluated");
      qc.invalidateQueries({ queryKey: ["payroll-readiness-summary"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Could not evaluate readiness"),
  });

  const summary = summaryQuery.data;
  const orgBlockers = summary?.org_blockers ?? [];
  const businessBlockers = summary?.business_blockers ?? [];
  const employeeBlockers = summary?.employee_blockers ?? [];
  const isReady = !!summary?.is_ready;

  // Legacy shape: a flat `blockers` array (org + business only — the page-level
  // badge historically only showed those). Employee blockers are exposed
  // separately so callers can decide how to render them.
  const legacyBlockers = useMemo(
    () => [...orgBlockers, ...businessBlockers],
    [orgBlockers, businessBlockers],
  );

  return {
    isLoading: summaryQuery.isLoading,
    isError: summaryQuery.isError,
    error: summaryQuery.error,
    hasEvaluation: !!summary,
    isReady,
    summary,
    orgBlockers,
    businessBlockers,
    employeeBlockers,
    /** @deprecated use orgBlockers + businessBlockers + employeeBlockers */
    blockers: legacyBlockers,
    /**
     * @deprecated Legacy shape — surfaces blockers as pseudo-findings
     * (`{ status: "fail", severity: "block" | "warn" }`) so older
     * destructuring callers keep working. Full per-finding history
     * lives in the `payroll_readiness_findings` table.
     */
    findings: useMemo(
      () => [
        ...orgBlockers.map((b) => ({
          status: "fail" as const,
          severity: (b.severity ?? "block") as "block" | "warn",
          rule_code: b.rule_code,
          subject_id: b.subject_id,
        })),
        ...businessBlockers.map((b) => ({
          status: "fail" as const,
          severity: (b.severity ?? "block") as "block" | "warn",
          rule_code: b.rule_code,
          subject_id: b.subject_id,
        })),
        ...employeeBlockers.map((b) => ({
          status: "fail" as const,
          severity: (b.severity ?? "block") as "block" | "warn",
          rule_code: b.rule_code,
          subject_id: b.subject_id,
        })),
      ],
      [orgBlockers, businessBlockers, employeeBlockers],
    ),
    evaluate,
    refetch: summaryQuery.refetch,
  };
}
