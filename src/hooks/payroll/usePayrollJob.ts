/**
 * Payroll job hooks — the UI's window into authoritative server-side
 * payroll execution state.
 *
 * ARCHITECTURAL CONTRACT:
 *   The browser MUST NOT infer whether payroll ran from the HTTP promise
 *   returned by `supabase.functions.invoke("compute-payroll", ...)`. The
 *   accept endpoint returns 202 and hands off to a background worker, so
 *   the invoke() promise says nothing about the run's outcome.
 *
 *   All UI that shows "is my payroll running / did it finish?" reads from
 *   `payroll_run_jobs` via these hooks. Realtime keeps the panel current
 *   even if the tab was refreshed mid-run.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export type PayrollJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface PayrollJobRow {
  id: string;
  organization_id: string;
  business_id: string | null;
  status: PayrollJobStatus | string;
  phase: string | null;
  progress_current: number;
  progress_total: number;
  heartbeat_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  attempt: number;
  pay_period_start: string;
  pay_period_end: string;
  run_type: string;
  employee_count: number;
  payroll_run_id: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

const ACTIVE_STATUSES: PayrollJobStatus[] = ["queued", "running"];

/**
 * Subscribe to all non-terminal payroll jobs for the current org, plus any
 * job that reached a terminal state in the last N minutes (so we can show
 * an outcome banner briefly after completion).
 */
export function useActivePayrollJobs(recentWindowMinutes = 15) {
  const { currentOrg } = useOrganization();
  const [jobs, setJobs] = useState<PayrollJobRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!currentOrg?.id) {
      setJobs([]);
      setLoading(false);
      return;
    }
    const cutoff = new Date(Date.now() - recentWindowMinutes * 60_000).toISOString();
    const { data, error } = await supabase
      .from("payroll_run_jobs")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .or(`status.in.(queued,running),finished_at.gte.${cutoff}`)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!error) {
      setJobs(((data as unknown) as PayrollJobRow[]) ?? []);
    }
    setLoading(false);
  }, [currentOrg?.id, recentWindowMinutes]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const orgId = currentOrg?.id;
    if (!orgId) return;
    const channel = supabase
      .channel(`payroll_jobs_active:${orgId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "payroll_run_jobs",
          filter: `organization_id=eq.${orgId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as PayrollJobRow;
          if (!row?.id) return;
          setJobs((prev) => {
            const next = prev.filter((j) => j.id !== row.id);
            if (payload.eventType === "DELETE") return next;
            next.unshift(row);
            return next.slice(0, 20);
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentOrg?.id]);

  const active = useMemo(
    () => jobs.filter((j) => ACTIVE_STATUSES.includes(j.status as PayrollJobStatus)),
    [jobs],
  );
  const recentTerminal = useMemo(
    () => jobs.filter((j) => !ACTIVE_STATUSES.includes(j.status as PayrollJobStatus)),
    [jobs],
  );

  return { jobs, active, recentTerminal, loading, refetch };
}

/** Ask the server to cancel a running job. Worker checks flag between employees. */
export async function requestCancelPayrollJob(jobId: string) {
  const { error } = await supabase.rpc("payroll_request_cancel" as any, {
    p_job_id: jobId,
  } as any);
  if (error) throw error;
}