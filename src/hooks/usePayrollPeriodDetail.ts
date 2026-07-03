import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PayrollPeriodBlocker {
  code: string;
  count: number;
  severity: "error" | "warning" | "info";
}

export interface PayrollPeriodReadiness {
  period_id: string;
  status: string;
  checked_at: string;
  ready: boolean;
  blockers: PayrollPeriodBlocker[];
  counts: Record<string, number>;
}

export interface PayrollPeriodAuditRow {
  id: string;
  period_id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  reason: string | null;
  payload: unknown;
  created_at: string;
}

/**
 * Fetches the readiness snapshot + audit trail for a single period.
 * Both are read-only and safe to poll — the readiness RPC is STABLE and
 * runs a handful of scoped COUNT(*) queries.
 */
export function usePayrollPeriodDetail(periodId: string | null | undefined) {
  const readiness = useQuery({
    queryKey: ["payroll-period-readiness", periodId],
    enabled: !!periodId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "payroll_period_readiness",
        { _period_id: periodId },
      );
      if (error) throw error;
      return data as PayrollPeriodReadiness;
    },
  });

  const audit = useQuery({
    queryKey: ["payroll-period-audit", periodId],
    enabled: !!periodId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_period_audit")
        .select("*")
        .eq("period_id", periodId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PayrollPeriodAuditRow[];
    },
  });

  return { readiness, audit };
}