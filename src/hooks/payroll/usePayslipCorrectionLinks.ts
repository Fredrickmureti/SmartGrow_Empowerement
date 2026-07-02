/**
 * Phase 4 P3 — Correction visibility.
 *
 * Resolves both sides of a payslip correction link:
 *   - `supersededBy` : the reversal payslip that replaced this one (if any).
 *   - `corrects`     : the original payslip this reversal cancels out (if any).
 *
 * Country-agnostic: relies only on the universal `payslips.*` columns added
 * in the P3 migration. No statutory vocabulary.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PayslipLinkRef {
  id: string;
  payroll_run_id: string | null;
  payroll_number: string | null;
  status: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
}

export interface PayslipCorrectionLinks {
  supersededBy: PayslipLinkRef | null;
  corrects: PayslipLinkRef | null;
}

interface PayslipRow {
  id: string;
  payroll_run_id: string | null;
  status: string | null;
  corrects_payslip_id: string | null;
  superseded_by_payslip_id: string | null;
}

interface RunRow {
  id: string;
  payroll_number: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
}

async function fetchLinkedPayslip(id: string): Promise<PayslipLinkRef | null> {
  const { data, error } = await supabase
    .from("payslips")
    .select("id, payroll_run_id, status")
    .eq("id", id)
    .maybeSingle<PayslipRow>();
  if (error || !data) return null;

  let run: RunRow | null = null;
  if (data.payroll_run_id) {
    const { data: runRow } = await supabase
      .from("payroll_runs")
      .select("id, payroll_number, pay_period_start, pay_period_end")
      .eq("id", data.payroll_run_id)
      .maybeSingle<RunRow>();
    run = runRow ?? null;
  }

  return {
    id: data.id,
    payroll_run_id: data.payroll_run_id,
    payroll_number: run?.payroll_number ?? null,
    status: data.status,
    pay_period_start: run?.pay_period_start ?? null,
    pay_period_end: run?.pay_period_end ?? null,
  };
}

export function usePayslipCorrectionLinks(payslipId: string | null | undefined) {
  return useQuery<PayslipCorrectionLinks>({
    queryKey: ["payslip-correction-links", payslipId],
    enabled: !!payslipId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payslips")
        .select("id, payroll_run_id, status, corrects_payslip_id, superseded_by_payslip_id")
        .eq("id", payslipId as string)
        .maybeSingle<PayslipRow>();
      if (error) throw error;
      if (!data) return { supersededBy: null, corrects: null };

      const [supersededBy, corrects] = await Promise.all([
        data.superseded_by_payslip_id
          ? fetchLinkedPayslip(data.superseded_by_payslip_id)
          : Promise.resolve(null),
        data.corrects_payslip_id
          ? fetchLinkedPayslip(data.corrects_payslip_id)
          : Promise.resolve(null),
      ]);

      return { supersededBy, corrects };
    },
    staleTime: 30_000,
  });
}
