/**
 * logReportRun — audit trail for report renditions that are NOT PDFs.
 *
 * `renderReport()` writes a `report_run_log` row for every PDF it produces,
 * but on-screen (JSON) and tabular (CSV/XLSX) renditions bypassed it
 * entirely. That left the audit trail claiming a report was never run when
 * a user had, in fact, viewed or exported it — the exact question an
 * auditor asks ("who saw these payroll figures, and when?").
 *
 * Best-effort by design: an audit failure must never fail the report.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface ReportRunAudit {
  organizationId?: string | null;
  businessId?: string | null;
  userId?: string | null;
  reportType?: string | null;
  /** Rendition actually delivered to the caller. */
  outputFormat: "json" | "csv" | "xlsx";
  /** Period + filters, so a run can be reproduced exactly. */
  params?: Record<string, unknown> | null;
  rowCount?: number;
  byteCount?: number;
  status?: "ok" | "error";
}

export async function logReportRun(
  supabase: SupabaseClient,
  audit: ReportRunAudit,
): Promise<void> {
  try {
    await supabase.from("report_run_log").insert({
      organization_id: audit.organizationId ?? null,
      business_id: audit.businessId ?? null,
      user_id: audit.userId ?? null,
      report_type: audit.reportType ?? "ad_hoc",
      // `output_format` and `row_count` live inside params so this works on
      // deployments whose `report_run_log` predates dedicated columns.
      params_jsonb: {
        ...(audit.params ?? {}),
        output_format: audit.outputFormat,
        row_count: audit.rowCount ?? null,
      },
      run_hash: null,
      byte_count: audit.byteCount ?? 0,
      status: audit.status ?? "ok",
    });
  } catch (e) {
    console.warn("[logReportRun] audit write skipped:", (e as Error).message);
  }
}
