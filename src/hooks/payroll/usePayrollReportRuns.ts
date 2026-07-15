/**
 * usePayrollReportRuns — history feed for the Payroll Reporting Centre.
 *
 * Reads `payroll_report_runs`, scoped to the current org/business, most
 * recent first. Every report generation (from the viewer or an edge
 * function) writes a row here so the History tab, audit trail and
 * re-export flows share one canonical source.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PayrollReportRun {
  id: string;
  organizationId: string;
  businessId: string | null;
  reportKey: string;
  reportLabel: string | null;
  ownerKind: string | null;
  params: Record<string, unknown>;
  filters: Record<string, unknown>;
  rowCount: number | null;
  employeeCount: number | null;
  durationMs: number | null;
  status: "succeeded" | "failed" | "cancelled";
  error: string | null;
  packCode: string | null;
  packVersion: string | null;
  templateVersion: string | null;
  sourcePayrollRunIds: string[];
  generatedBy: string | null;
  generatedAt: string;
}

function normalize(r: any): PayrollReportRun {
  return {
    id: r.id,
    organizationId: r.organization_id,
    businessId: r.business_id,
    reportKey: r.report_key,
    reportLabel: r.report_label,
    ownerKind: r.owner_kind,
    params: r.params ?? {},
    filters: r.filters ?? {},
    rowCount: r.row_count,
    employeeCount: r.employee_count,
    durationMs: r.duration_ms,
    status: r.status,
    error: r.error,
    packCode: r.pack_code,
    packVersion: r.pack_version,
    templateVersion: r.template_version,
    sourcePayrollRunIds: r.source_payroll_run_ids ?? [],
    generatedBy: r.generated_by,
    generatedAt: r.generated_at,
  };
}

export function usePayrollReportRuns(params: {
  organizationId?: string | null;
  businessId?: string | null;
  reportKey?: string | null;
  limit?: number;
}) {
  const { organizationId, businessId, reportKey, limit = 50 } = params;
  return useQuery({
    queryKey: [
      "payroll-report-runs",
      organizationId ?? null,
      businessId ?? null,
      reportKey ?? null,
      limit,
    ],
    enabled: !!organizationId,
    queryFn: async (): Promise<PayrollReportRun[]> => {
      let q = (supabase as any)
        .from("payroll_report_runs")
        .select("*")
        .eq("organization_id", organizationId)
        .order("generated_at", { ascending: false })
        .limit(limit);
      if (businessId) q = q.eq("business_id", businessId);
      if (reportKey) q = q.eq("report_key", reportKey);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map(normalize);
    },
  });
}

/**
 * Records a payroll report generation. Called by the viewer after a
 * successful `render-report` invocation.
 */
export function useRecordPayrollReportRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      organizationId: string;
      businessId: string | null;
      reportKey: string;
      reportLabel: string;
      ownerKind: string;
      params: Record<string, unknown>;
      filters: Record<string, unknown>;
      rowCount: number;
      employeeCount?: number | null;
      durationMs: number;
      status?: "succeeded" | "failed";
      error?: string | null;
      packCode?: string | null;
      packVersion?: string | null;
      templateVersion?: string | null;
      sourcePayrollRunIds?: string[];
    }) => {
      const { error } = await (supabase as any)
        .from("payroll_report_runs")
        .insert({
          organization_id: input.organizationId,
          business_id: input.businessId,
          report_key: input.reportKey,
          report_label: input.reportLabel,
          owner_kind: input.ownerKind,
          params: input.params,
          filters: input.filters,
          row_count: input.rowCount,
          employee_count: input.employeeCount ?? null,
          duration_ms: input.durationMs,
          status: input.status ?? "succeeded",
          error: input.error ?? null,
          pack_code: input.packCode ?? null,
          pack_version: input.packVersion ?? null,
          template_version: input.templateVersion ?? null,
          source_payroll_run_ids: input.sourcePayrollRunIds ?? [],
        });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-report-runs"] });
    },
  });
}
