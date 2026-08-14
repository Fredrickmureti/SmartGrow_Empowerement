/**
 * Labour — incentive pay hand-off (WLM Phase H.3).
 *
 * Warehouse performance must never grow its own earnings path. The only
 * route from a scorecard to pay is `payroll_pending_inputs`: a
 * payroll-owned staging inbox that the payroll create-run flow consumes.
 *
 * All money maths lives in `wms_post_incentive_inputs` (SECURITY DEFINER):
 * it reads the scorecard for the window, keeps only operators flagged
 * `incentive_eligible`, resolves each operator's date-effective target for
 * the rate, refuses closed payroll periods, and upserts one pending row per
 * employee so re-posting a window cannot double-pay. The browser only picks
 * a window and an input code.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { labourErrorMessage } from "./labourErrors";
import { useBusinesses } from "@/hooks/useBusinesses";

export const INCENTIVE_SOURCE_KIND = "wms_labour_incentive";

export interface PendingIncentiveRow {
  id: string;
  employee_id: string;
  code: string;
  label: string | null;
  quantity: number;
  amount: number;
  period_start: string;
  period_end: string;
  status: string;
  consumed_payroll_run_id: string | null;
  metadata: Record<string, unknown> | null;
}

export const INCENTIVE_KEYS = {
  staged: ["wms", "labour", "incentive", "staged"] as const,
};

/** Warehouse-staged incentive rows, newest window first. */
export function useStagedIncentives() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [...INCENTIVE_KEYS.staged, currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async (): Promise<PendingIncentiveRow[]> => {
      const { data, error } = await supabase
        .from("payroll_pending_inputs")
        .select(
          "id, employee_id, code, label, quantity, amount, period_start, period_end, status, consumed_payroll_run_id, metadata",
        )
        .eq("business_id", currentBusiness!.id)
        .eq("source_kind", INCENTIVE_SOURCE_KIND)
        .order("period_end", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as PendingIncentiveRow[];
    },
  });
}

/** Available payroll input slots (codes) the pack has declared. */
export function usePayrollInputCodes() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["payroll-input-codes", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_input_types")
        .select("code, name, business_id")
        .eq("is_active", true)
        .order("sequence");
      if (error) throw error;
      return (data ?? []) as Array<{ code: string; name: string; business_id: string | null }>;
    },
  });
}

export function usePostIncentiveInputs() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();

  return useMutation({
    mutationFn: async (input: {
      code: string;
      from: string;
      to: string;
      warehouseId?: string;
    }) => {
      if (!currentBusiness?.id) throw new Error("No business selected");
      const { data, error } = await supabase.rpc("wms_post_incentive_inputs", {
        _business_id: currentBusiness.id,
        _code: input.code,
        _from: input.from,
        _to: input.to,
        _warehouse_id: input.warehouseId ?? undefined,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | { employees_staged: number; total_amount: number }
        | undefined;
      return row ?? { employees_staged: 0, total_amount: 0 };
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: INCENTIVE_KEYS.staged });
      if (result.employees_staged === 0) {
        toast.info("No operators qualified for incentive pay in this window");
      } else {
        toast.success(
          `Staged incentive pay for ${result.employees_staged} employee${
            result.employees_staged === 1 ? "" : "s"
          } (${result.total_amount})`,
        );
      }
    },
    onError: (e: Error) => toast.error(labourErrorMessage(e) || "Incentive pay could not be staged"),
  });
}
