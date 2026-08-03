/**
 * Pre-run payroll input inbox (Phase H.3).
 *
 * `payroll_pending_inputs` is the only persisted hand-off other modules use
 * to push pay inputs at payroll. Warehouse incentive pay lands here; the
 * create-run flow prefills its variable-earnings grid from it, and marks the
 * rows consumed once a run exists (released again if that run is reversed).
 *
 * Codes always match an active `payroll_input_types.code`, so nothing here
 * can invent an earning the localization pack has not declared.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import type { VariableEarningsInput } from "@/hooks/usePayroll";

export interface PendingPayrollInput {
  id: string;
  employee_id: string;
  code: string;
  label: string | null;
  amount: number;
  quantity: number;
  period_start: string;
  period_end: string;
  source_kind: string;
}

/** Pending rows whose window falls inside the run period. */
export function usePendingPayrollInputs(periodStart?: string, periodEnd?: string) {
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["payroll-pending-inputs", currentBusiness?.id, periodStart, periodEnd],
    enabled: !!currentBusiness?.id && !!periodStart && !!periodEnd,
    queryFn: async (): Promise<PendingPayrollInput[]> => {
      const { data, error } = await supabase
        .from("payroll_pending_inputs")
        .select(
          "id, employee_id, code, label, amount, quantity, period_start, period_end, source_kind",
        )
        .eq("business_id", currentBusiness!.id)
        .eq("status", "pending")
        .gte("period_start", periodStart!)
        .lte("period_end", periodEnd!);
      if (error) throw error;
      return (data ?? []) as unknown as PendingPayrollInput[];
    },
  });
}

/**
 * Fold staged rows into the variable-earnings grid shape. Values the user
 * has already typed win, so a prefill never overwrites a manual override.
 */
export function mergePendingIntoVariableEarnings(
  current: VariableEarningsInput[],
  pending: PendingPayrollInput[],
): VariableEarningsInput[] {
  if (!pending.length) return current;
  const byEmployee = new Map<string, VariableEarningsInput>();
  for (const row of current) byEmployee.set(row.employee_id, { ...row });

  for (const p of pending) {
    if (!p.amount) continue;
    const existing = byEmployee.get(p.employee_id) ?? { employee_id: p.employee_id };
    if (typeof existing[p.code] === "number") continue; // manual entry wins
    existing[p.code] = Number(p.amount);
    byEmployee.set(p.employee_id, existing);
  }
  return Array.from(byEmployee.values());
}

/** Mark every pending row inside the period as consumed by this run. */
export async function consumePendingPayrollInputs(
  businessId: string,
  payrollRunId: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("payroll_consume_pending_inputs", {
    _business_id: businessId,
    _payroll_run_id: payrollRunId,
    _period_start: periodStart,
    _period_end: periodEnd,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Release rows back to pending when their run is reversed or cancelled. */
export async function releasePendingPayrollInputs(
  businessId: string,
  payrollRunId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("payroll_release_pending_inputs", {
    _business_id: businessId,
    _payroll_run_id: payrollRunId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}
