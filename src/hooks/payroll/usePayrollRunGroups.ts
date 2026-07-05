/**
 * usePayrollRunGroups — read & lifecycle hook for ADR-0045 payroll batches.
 *
 * Reads
 * -----
 * - List rows from `v_payroll_batches`. The view computes headcount + totals
 *   from child `payroll_runs` so this hook never rolls them up client-side.
 * - Child runs (for the assign / detail panels) come from `payroll_runs`.
 * - Cross-entity period totals come from `v_payroll_period_consolidation`.
 *
 * Scoping
 * -------
 * Every list is scoped by (organization_id, current_business_id). Batches are
 * a single-business control record per ADR-0045 §6; mixing businesses in the
 * UI would be a data-isolation defect.
 *
 * Errors
 * ------
 * RPC errors are run through `parseGovernanceError` so SoD / permission / approver
 * refusals surface with the canonical title + body instead of a raw Postgres
 * message.
 */
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";
import {
  parseGovernanceError,
  describeGovernanceError,
} from "@/lib/governance/selfActionErrors";


export interface PayrollRunGroup {
  id: string;
  organization_id: string;
  business_id: string | null;
  pay_schedule_id: string | null;
  country_code: string | null;
  name: string;
  period_start: string;
  period_end: string;
  status: string;
  run_type: string;
  notes: string | null;
  batch_number: string;
  parent_batch_id: string | null;
  reversal_batch_id: string | null;
  readiness_snapshot_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_by: string | null;
  posted_at: string | null;
  paid_by: string | null;
  paid_at: string | null;
  payment_batch_id: string | null;
  closed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Aggregates from v_payroll_batches.
  child_run_count: number;
  headcount: number;
  total_gross: number;
  total_net: number;
  total_other_deductions: number;
  total_employer_contributions: number;
}

export interface ChildRunSummary {
  id: string;
  payroll_number: string;
  status: string;
  pay_period_start: string;
  pay_period_end: string;
  employee_count: number;
  total_gross: number;
  total_net: number;
  total_employer_contributions: number;
  group_id: string | null;
  business_id: string | null;
  // Parallel-workflow state columns (plan §Phase 1). These are the
  // independent lifecycles derived from Approval — Posting / Payment /
  // Bank File / Payslip Issuance. They are NEVER a chain: each advances
  // on its own preconditions, and the classic `status` column is the
  // Calculation lifecycle only.
  approved_at: string | null;
  posting_status: string | null;
  payment_status: string | null;
  bank_file_status: string | null;
  payslip_issuance_status: string | null;
}

export interface PeriodConsolidation {
  organization_id: string;
  business_id: string | null;
  period_start: string;
  period_end: string;
  batch_count: number;
  run_count: number;
  headcount: number;
  total_gross: number;
  total_net: number;
  total_employer_contributions: number;
}

/**
 * Per-child-run issue rollup sourced from `payroll_run_issues`. Only undismissed,
 * unresolved rows are counted. Drives the readiness chips on each child row so
 * operators see blockers BEFORE clicking Submit / Approve.
 */
export interface ChildRunIssueRollup {
  payroll_run_id: string;
  blocker_count: number;
  warning_count: number;
  info_count: number;
}


/** Format a Postgres / Supabase error for an end-user toast. */
function reportError(fallback: string, error: unknown) {
  const g = parseGovernanceError(error);
  if (g) {
    const { title, body } = describeGovernanceError(g);
    toast.error(title, { description: body });
    return;
  }
  const msg =
    (error as { message?: string } | null)?.message ??
    (typeof error === "string" ? error : fallback);
  toast.error(fallback, { description: msg });
}

export function usePayrollRunGroups() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const scopeReady = !!orgId && !!businessId;

  const groupsQuery = useQuery({
    queryKey: ["payroll-batches", orgId, businessId],
    enabled: scopeReady,
    queryFn: async (): Promise<PayrollRunGroup[]> => {
      const { data, error } = await supabase
        .from("v_payroll_batches")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("period_end", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PayrollRunGroup[];
    },
  });

  const childRunsQuery = useQuery({
    queryKey: ["payroll-batches-children", orgId, businessId],
    enabled: scopeReady,
    queryFn: async (): Promise<ChildRunSummary[]> => {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select(
          "id, payroll_number, status, pay_period_start, pay_period_end, employee_count, total_gross, total_net, total_employer_contributions, group_id, business_id",
        )
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("pay_period_end", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ChildRunSummary[];
    },
  });

  /**
   * Cross-entity consolidation: one row per (org, business, period) from
   * `v_payroll_period_consolidation`. Operators viewing a single business see
   * just their row; org-wide ops can drill across rows when we expose a
   * dedicated consolidation route (Phase 7.2).
   */
  const consolidationQuery = useQuery({
    queryKey: ["payroll-period-consolidation", orgId, businessId],
    enabled: scopeReady,
    queryFn: async (): Promise<PeriodConsolidation[]> => {
      const { data, error } = await supabase
        .from("v_payroll_period_consolidation")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("period_end", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PeriodConsolidation[];
    },
  });

  /**
   * Open issues per child run (severity rollup). Used to render readiness
   * chips on each child row and to block lifecycle transitions in the UI
   * before the RPC rejects (Phase 2.3).
   */
  const childRunIds = (childRunsQuery.data ?? []).map((r) => r.id);
  const issuesQuery = useQuery({
    queryKey: ["payroll-batches-child-issues", orgId, businessId, childRunIds.length],
    enabled: scopeReady && childRunIds.length > 0,
    queryFn: async (): Promise<ChildRunIssueRollup[]> => {
      const { data, error } = await supabase
        .from("payroll_run_issues")
        .select("payroll_run_id, severity")
        .in("payroll_run_id", childRunIds)
        .is("resolved_at", null)
        .is("dismissed_at", null);
      if (error) throw error;
      const map = new Map<string, ChildRunIssueRollup>();
      for (const row of (data ?? []) as Array<{ payroll_run_id: string; severity: string }>) {
        const cur = map.get(row.payroll_run_id) ?? {
          payroll_run_id: row.payroll_run_id,
          blocker_count: 0, warning_count: 0, info_count: 0,
        };
        if (row.severity === "blocker" || row.severity === "error") cur.blocker_count += 1;
        else if (row.severity === "warning") cur.warning_count += 1;
        else cur.info_count += 1;
        map.set(row.payroll_run_id, cur);
      }
      return Array.from(map.values());
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["payroll-batches"] });
    qc.invalidateQueries({ queryKey: ["payroll-batches-children"] });
    qc.invalidateQueries({ queryKey: ["payroll-period-consolidation"] });
    qc.invalidateQueries({ queryKey: ["payroll-batches-child-issues"] });
    qc.invalidateQueries({ queryKey: ["payroll-batch-readiness-snapshot"] });
  };

  /**
   * Realtime: any UPDATE/INSERT on payroll_run_groups for the current
   * business invalidates the batch list so a second operator's actions
   * propagate without manual refresh (Phase 5.3).
   */
  useEffect(() => {
    if (!scopeReady) return;
    const channel = supabase
      .channel(`payroll-batches-${businessId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "payroll_run_groups", filter: `business_id=eq.${businessId}` },
        () => invalidateAll(),
      )
      .on("postgres_changes",
        { event: "*", schema: "public", table: "payroll_runs", filter: `business_id=eq.${businessId}` },
        () => invalidateAll(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeReady, businessId]);


  const createGroup = useMutation({
    mutationFn: async (input: {
      name?: string;
      period_start: string;
      period_end: string;
      notes?: string;
      pay_schedule_id?: string | null;
      run_type?: string;
      idempotency_key?: string;
      country_code?: string | null;
      parent_batch_id?: string | null;
    }) => {
      if (!orgId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a business before creating a batch");
      const knownIds = new Set((groupsQuery.data ?? []).map((g) => g.id));
      const { data, error } = await supabase.rpc("payroll_batch_create", {
        p_organization_id: orgId,
        p_business_id: businessId,
        p_pay_schedule_id: input.pay_schedule_id ?? null,
        p_period_start: input.period_start,
        p_period_end: input.period_end,
        p_run_type: input.run_type ?? "regular",
        p_name: input.name ?? null,
        p_idempotency_key: input.idempotency_key ?? null,
        p_notes: input.notes ?? null,
        p_country_code: input.country_code ?? null,
        p_parent_batch_id: input.parent_batch_id ?? null,
      } as never);
      if (error) throw error;
      const id = data as unknown as string;
      return { id, reused: !!id && knownIds.has(id) };
    },
    onSuccess: (result) => {
      if (result?.reused) {
        toast.info("Reused existing batch (idempotency key matched)");
      } else {
        toast.success("Payroll batch created");
      }
      invalidateAll();
    },
    onError: (e) => reportError("Failed to create batch", e),
  });

  const submitBatch = useMutation({
    mutationFn: async (batchId: string) => {
      const { data, error } = await supabase.rpc("payroll_batch_submit", {
        p_batch_id: batchId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch submitted for review");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to submit batch", e),
  });

  const approveBatch = useMutation({
    mutationFn: async (input: string | { batchId: string; overrideReason?: string }) => {
      const batchId = typeof input === "string" ? input : input.batchId;
      const overrideReason = typeof input === "string" ? undefined : input.overrideReason;
      const { data, error } = await supabase.rpc("payroll_batch_approve", {
        p_batch_id: batchId,
        p_override_reason: overrideReason ?? null,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch approved");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to approve batch", e),
  });

  const cancelBatch = useMutation({
    mutationFn: async (input: { batchId: string; reason?: string }) => {
      const { data, error } = await supabase.rpc("payroll_batch_cancel", {
        p_batch_id: input.batchId,
        p_reason: input.reason ?? null,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch cancelled");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to cancel batch", e),
  });

  const markPosted = useMutation({
    mutationFn: async (batchId: string) => {
      const { data, error } = await supabase.rpc("payroll_batch_mark_posted", {
        p_batch_id: batchId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch marked posted");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to mark batch posted", e),
  });

  const markPaid = useMutation({
    mutationFn: async (batchId: string) => {
      const { data, error } = await supabase.rpc("payroll_batch_mark_paid", {
        p_batch_id: batchId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch marked paid");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to mark batch paid", e),
  });

  const closeBatch = useMutation({
    mutationFn: async (batchId: string) => {
      const { data, error } = await supabase.rpc("payroll_batch_close", {
        p_batch_id: batchId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch closed");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to close batch", e),
  });

  const assignRuns = useMutation({
    mutationFn: async (input: { groupId: string; runIds: string[] }) => {
      const { error } = await supabase
        .from("payroll_runs")
        .update({ group_id: input.groupId })
        .in("id", input.runIds);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Runs added to batch");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to assign runs", e),
  });

  const unassignRun = useMutation({
    mutationFn: async (runId: string) => {
      const { error } = await supabase
        .from("payroll_runs")
        .update({ group_id: null })
        .eq("id", runId);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: (e) => reportError("Failed to remove run", e),
  });

  const reverseBatch = useMutation({
    mutationFn: async (input: { batchId: string; reason: string }) => {
      const { data, error } = await supabase.rpc("payroll_batch_reverse", {
        p_batch_id: input.batchId,
        p_reason: input.reason,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch reversed; sibling correction batch created");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to reverse batch", e),
  });

  const addRunToBatch = useMutation({
    mutationFn: async (input: {
      batchId: string;
      payPeriodStart: string;
      payPeriodEnd: string;
      paymentDate?: string;
      runType?: string;
      notes?: string;
    }) => {
      const { data, error } = await supabase.rpc("payroll_batch_add_run", {
        p_batch_id: input.batchId,
        p_pay_period_start: input.payPeriodStart,
        p_pay_period_end: input.payPeriodEnd,
        p_payment_date: input.paymentDate ?? null,
        p_run_type: input.runType ?? "regular",
        p_notes: input.notes ?? null,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Run added to batch");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to add run", e),
  });

  const linkPaymentBatch = useMutation({
    mutationFn: async (input: { paymentBatchId: string; batchId: string }) => {
      const { data, error } = await supabase.rpc("payroll_payment_batch_link", {
        p_payment_batch_id: input.paymentBatchId,
        p_batch_id: input.batchId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Payment batch linked");
      invalidateAll();
    },
    onError: (e) => reportError("Failed to link payment batch", e),
  });

  return {
    groups: groupsQuery.data ?? [],
    childRuns: childRunsQuery.data ?? [],
    consolidation: consolidationQuery.data ?? [],
    issues: issuesQuery.data ?? [],
    isLoading:
      groupsQuery.isLoading ||
      childRunsQuery.isLoading ||
      consolidationQuery.isLoading,
    scopeReady,
    createGroup,
    submitBatch,
    approveBatch,
    cancelBatch,
    markPosted,
    markPaid,
    closeBatch,
    assignRuns,
    unassignRun,
    reverseBatch,
    addRunToBatch,
    linkPaymentBatch,
  };
}
