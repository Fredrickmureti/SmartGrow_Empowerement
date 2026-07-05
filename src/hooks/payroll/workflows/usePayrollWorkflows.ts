/**
 * Six parallel-workflow hooks (plan §Phase 5a).
 *
 * These hooks are thin, side-effect-free projections over `payroll_runs`
 * (or `payroll_periods` / `payroll_remittances`) that surface the state
 * and preconditions of each downstream lifecycle. They are the read model
 * that the WorkflowStrip and per-workflow drawers render.
 *
 * Architectural invariant (plan §Phase 5b):
 *   Only `usePayrollPostingWorkflow` reads the calculation `status`
 *   indirectly (via `approved_at`). Every other workflow reads its own
 *   dedicated column so the "workflows are peers, not a chain" guarantee
 *   survives.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { WorkflowSnapshot, WorkflowPrecondition } from "./types";

function pre(code: string, message: string, satisfied: boolean): WorkflowPrecondition {
  return { code, message, satisfied };
}

interface RunRow {
  id: string;
  status: string;
  approved_at: string | null;
  approved_by: string | null;
  posted_at: string | null;
  posted_by: string | null;
  payment_date: string | null;
  posting_status: string | null;
  payment_status: string | null;
  bank_file_status: string | null;
  payslip_issuance_status: string | null;
}

function useRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: ["payroll", "workflow", "run", runId],
    enabled: !!runId,
    queryFn: async (): Promise<RunRow | null> => {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select(
          "id,status,approved_at,approved_by,posted_at,posted_by,payment_date,posting_status,payment_status,bank_file_status,payslip_issuance_status",
        )
        .eq("id", runId!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as RunRow | null;
    },
  });
}

export function usePayrollPostingWorkflow(runId: string | null | undefined): WorkflowSnapshot {
  const { data, isLoading, error } = useRun(runId);
  const state = (data?.posting_status ?? "not_posted") as string;
  const approved = !!data?.approved_at;
  const preconditions: WorkflowPrecondition[] = [
    pre("APPROVED", "Payroll run must be approved.", approved),
    pre("NOT_ALREADY_POSTED", "Run is not already posted.", state !== "posted"),
  ];
  return {
    workflow: "posting",
    state,
    canAdvance: preconditions.every((p) => p.satisfied),
    preconditions,
    lastActor: { userId: data?.posted_by ?? null, at: data?.posted_at ?? null },
    loading: isLoading,
    error,
  };
}

export function usePayrollPaymentWorkflow(runId: string | null | undefined): WorkflowSnapshot {
  const { data, isLoading, error } = useRun(runId);
  const state = (data?.payment_status ?? "pending") as string;
  const approved = !!data?.approved_at;
  const preconditions: WorkflowPrecondition[] = [
    pre("APPROVED", "Payroll run must be approved.", approved),
    pre("NOT_FINAL", "Payment not already fully paid or on hold.", state !== "fully_paid" && state !== "on_hold"),
  ];
  return {
    workflow: "payment",
    state,
    canAdvance: preconditions.every((p) => p.satisfied),
    preconditions,
    lastActor: { userId: data?.paid_by ?? null, at: data?.paid_at ?? null },
    loading: isLoading,
    error,
  };
}

export function usePayrollBankFileWorkflow(runId: string | null | undefined): WorkflowSnapshot {
  const { data, isLoading, error } = useRun(runId);
  const state = (data?.bank_file_status ?? "not_generated") as string;
  const approved = !!data?.approved_at;
  const preconditions: WorkflowPrecondition[] = [
    pre("APPROVED", "Payroll run must be approved.", approved),
    pre(
      "NOT_TERMINAL",
      "Bank file not already sent, acknowledged, or explicitly waived.",
      state !== "sent" && state !== "acknowledged" && state !== "not_generated_waived",
    ),
  ];
  return {
    workflow: "bank_file",
    state,
    canAdvance: preconditions.every((p) => p.satisfied),
    preconditions,
    lastActor: null,
    loading: isLoading,
    error,
  };
}

export function usePayrollReturnsWorkflow(runId: string | null | undefined): WorkflowSnapshot {
  const { data, isLoading, error } = useRun(runId);
  const approved = !!data?.approved_at;
  const state = approved ? "available" : "locked";
  const preconditions: WorkflowPrecondition[] = [
    pre("APPROVED", "Payroll run must be approved. Returns are peers of Approval, not of Payment.", approved),
  ];
  return {
    workflow: "returns",
    state,
    canAdvance: approved,
    preconditions,
    lastActor: null,
    loading: isLoading,
    error,
  };
}

export function usePayrollRemittanceWorkflow(periodId: string | null | undefined): WorkflowSnapshot {
  const { data, isLoading, error } = useQuery({
    queryKey: ["payroll", "workflow", "remittance", periodId],
    enabled: !!periodId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_remittances")
        .select("id,status,submitted_at,submitted_by")
        .eq("payroll_period_id", periodId!);
      if (error) throw error;
      return data ?? [];
    },
  });
  const rows = data ?? [];
  const total = rows.length;
  const submitted = rows.filter((r: any) => r.status === "submitted" || r.status === "accepted").length;
  const state = total === 0 ? "none" : submitted === total ? "all_submitted" : submitted > 0 ? "partial" : "pending";
  const preconditions: WorkflowPrecondition[] = [
    pre("RETURNS_PRESENT", "At least one statutory return exists for the period.", total > 0),
  ];
  return {
    workflow: "remittance",
    state,
    canAdvance: total > 0 && submitted < total,
    preconditions,
    lastActor: null,
    loading: isLoading,
    error,
  };
}

export function usePayrollPeriodCloseWorkflow(periodId: string | null | undefined): WorkflowSnapshot {
  const { data, isLoading, error } = useQuery({
    queryKey: ["payroll", "workflow", "period_close", periodId],
    enabled: !!periodId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_periods")
        .select("id,status,closed_at,closed_by")
        .eq("id", periodId!)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; status: string; closed_at: string | null; closed_by: string | null } | null;
    },
  });
  const state = data?.status ?? "open";
  const closed = !!data?.closed_at;
  const preconditions: WorkflowPrecondition[] = [
    pre("NOT_CLOSED", "Period is not already closed.", !closed),
  ];
  return {
    workflow: "period_close",
    state,
    canAdvance: !closed,
    preconditions,
    lastActor: { userId: data?.closed_by ?? null, at: data?.closed_at ?? null },
    loading: isLoading,
    error,
  };
}