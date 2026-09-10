/**
 * Daily branch cash report.
 *
 * Every figure comes from the `branch_day_cash_report` function, which reads
 * the posted ledger and the day records themselves. Nothing is totalled in the
 * browser beyond adding up rows the server already produced, so the report can
 * never disagree with the general ledger.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface BranchDayCashRow {
  day_id: string;
  business_date: string;
  status: string;
  opening_cash: number;
  cash_in: number;
  cash_out: number;
  expected_cash: number;
  counted_cash: number | null;
  variance: number | null;
  variance_reason: string | null;
  opened_by: string | null;
  closed_by: string | null;
  closed_at: string | null;
}

export function useBranchDayCashReport(
  branchId: string | null | undefined,
  from: string,
  to: string,
) {
  const query = useQuery({
    queryKey: ["branch-day-cash-report", branchId ?? null, from, to],
    queryFn: async () => {
      if (!branchId) return [] as BranchDayCashRow[];
      const { data, error } = await supabase.rpc("branch_day_cash_report", {
        p_branch_id: branchId,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        day_id: r.day_id,
        business_date: r.business_date,
        status: r.status,
        opening_cash: Number(r.opening_cash ?? 0),
        cash_in: Number(r.cash_in ?? 0),
        cash_out: Number(r.cash_out ?? 0),
        expected_cash: Number(r.expected_cash ?? 0),
        counted_cash: r.counted_cash == null ? null : Number(r.counted_cash),
        variance: r.variance == null ? null : Number(r.variance),
        variance_reason: r.variance_reason ?? null,
        opened_by: r.opened_by ?? null,
        closed_by: r.closed_by ?? null,
        closed_at: r.closed_at ?? null,
      })) as BranchDayCashRow[];
    },
    enabled: !!branchId,
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
