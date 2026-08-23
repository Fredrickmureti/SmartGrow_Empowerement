/**
 * render-report — canonical server entrypoint for ALL programmatic report
 * generation (live report pages, scheduled reports, "email this report"
 * buttons, future audit packs, API integrations).
 *
 * Two input modes are accepted:
 *
 * 1. SERVER-BUILD mode (preferred for financial reports):
 *      { reportType, organizationId, dateFrom, dateTo, format? }
 *    The function fetches the data through `buildReportData` and renders
 *    using the registry column spec + financial format profile.
 *
 * 2. PREBUILT mode (used by the live UI when the page already has rows):
 *      { columns, rows, title, dateRange?, organizationId, ...optional }
 *    Pages call this directly via ReportExportService. Branding +
 *    audit + format profile are still applied centrally — the page only
 *    supplies the data.
 *
 * After Stages A/B/E + Stage 2 of the consolidation:
 *   - Column shapes resolve from the central registry
 *     (`_shared/reports/columnSpecs.ts`) — no more first-row inference.
 *   - Branding + entitlement + render flow live in one helper
 *     (`_shared/reports/renderReport.ts`).
 *   - JSON responses include any per-row `_meta` (accountId, journalId,
 *     sourceDocType, sourceDocId) so the UI can drive drill-down without
 *     re-fetching.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  buildBalanceSheet,
  buildTrialBalance,
  buildIncomeStatement,
  buildComparativeIncomeStatement,
  buildCashFlow,
  buildBankReconciliation,
  buildGeneralLedger,
  buildPartnerLedger,
  buildJournalReport,
  buildBudgetVsActual,
  buildBudgetSchedule,
  buildDepreciationSchedule,
  buildAuditTrail,
  type ComparisonMode,
  type ReportResult,
} from "../_shared/reportDataEngine.ts";
import { renderReport, getReportTitle } from "../_shared/reports/index.ts";
import { scopeBranchForReport } from "../_shared/reports/branchScopability.ts";

import { resolveReportColumns } from "../_shared/reports/resolveColumns.ts";
import { logReportRun } from "../_shared/reports/logReportRun.ts";
import {
  buildAttendanceReport,
  type AttendanceReportKey,
  type AttendanceFilters,
} from "../_shared/reports/attendanceData.ts";
import {
  buildPayrollReport,
  type PayrollReportKey,
  type PayrollFilters,
} from "../_shared/reports/payrollData.ts";
import {
  buildPayrollExtendedReport,
  type PayrollExtendedReportKey,
  type PayrollExtendedFilters,
} from "../_shared/reports/payrollExtendedData.ts";
import {
  buildProjectReport,
  type ProjectReportKey,
  type ProjectFilters,
} from "../_shared/reports/projectsData.ts";
import {
  buildInventoryReport,
  type InventoryReportKey,
  type InventoryFilters,
} from "../_shared/reports/inventoryData.ts";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export type ReportType =
  | "balance_sheet"
  | "trial_balance"
  | "income_statement"
  | "profit_and_loss"
  | "cash_flow"
  | "bank_reconciliation"
  | "general_ledger"
  | "partner_ledger"
  | "journal_report"
  | "budget_vs_actual"
  | "budget_schedule"
  | "depreciation_schedule"
  | "audit_trail"
  | AttendanceReportKey
  | PayrollReportKey
  | PayrollExtendedReportKey
  | ProjectReportKey
  | InventoryReportKey;


/**
 * Dispatch a report build by type. Pure data — no PDF.
 * Exported so other edge functions can call it without going through HTTP.
 */
export async function buildReportData(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  reportType: Exclude<ReportType, AttendanceReportKey>,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  // Branch is a REPORTING DIMENSION, not a decoration: a report built without
  // it silently states the whole business under a branch-scoped title.
  // Conversely, entity-level statements (balance sheet, trial balance, cash
  // flow, tax…) must never be sliced by branch — the shared registry is the
  // one rule, and it is the same one the screens obey.
  branchIdInput?: string,
  filters?: Record<string, unknown>,
): Promise<ReportResult> {
  const branchId = scopeBranchForReport(reportType, branchIdInput);
  const comparisonModeRaw = filters?.comparison_mode ?? filters?.comparisonMode;
  const comparisonMode: ComparisonMode =
    comparisonModeRaw === "previous_period" || comparisonModeRaw === "previous_year"
      ? comparisonModeRaw
      : "none";

  switch (reportType) {


    case "balance_sheet":
      return await buildBalanceSheet(supabase, orgId, businessId, dateFrom, dateTo);
    case "trial_balance":
      return await buildTrialBalance(supabase, orgId, businessId, dateFrom, dateTo, branchId);
    case "income_statement":
    case "profit_and_loss":
      return comparisonMode === "none"
        ? await buildIncomeStatement(supabase, orgId, businessId, dateFrom, dateTo, branchId)
        : await buildComparativeIncomeStatement(
            supabase,
            orgId,
            businessId,
            dateFrom,
            dateTo,
            branchId,
            comparisonMode,
          );
    case "cash_flow":
      return await buildCashFlow(supabase, orgId, businessId, dateFrom, dateTo, branchId);
    case "bank_reconciliation":
      return await buildBankReconciliation(
        supabase,
        orgId,
        businessId,
        dateTo,
        String((filters?.bankAccountId ?? filters?.bank_account_id ?? "") as string),
        branchId,
      );
    case "general_ledger":
      return await buildGeneralLedger(supabase, orgId, businessId, dateFrom, dateTo, branchId);
    case "partner_ledger":
      return await buildPartnerLedger(supabase, orgId, businessId, dateFrom, dateTo, branchId);
    case "journal_report":
      return await buildJournalReport(supabase, orgId, businessId, dateFrom, dateTo, branchId);

    case "budget_vs_actual":
      // An explicit budget wins; without one the builder resolves the budget
      // in force for the requested window's fiscal year.
      return await buildBudgetVsActual(
        supabase,
        orgId,
        businessId,
        dateFrom,
        dateTo,
        (filters?.budgetId ?? filters?.budget_id) as string | undefined,
      );
    case "budget_schedule":
      return await buildBudgetSchedule(
        supabase,
        businessId,
        (filters?.budgetId ?? filters?.budget_id) as string | undefined,
      );

    case "depreciation_schedule":
      return await buildDepreciationSchedule(supabase, orgId);
    case "audit_trail":
      return await buildAuditTrail(supabase, orgId, dateFrom, dateTo);
    default:
      throw new Error(`Unsupported report type: ${reportType}`);
  }
}


/** Resolve who triggered the run from the bearer JWT (if any). */
async function resolveCaller(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  authHeader: string | null,
): Promise<{ userId: string | null; userName: string | null }> {
  if (!authHeader) return { userId: null, userName: null };
  try {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data } = await supabase.auth.getUser(token);
    const u = data?.user;
    if (!u) return { userId: null, userName: null };
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      (meta.full_name as string) ||
      (meta.name as string) ||
      u.email ||
      null;
    return { userId: u.id, userName: name };
  } catch {
    return { userId: null, userName: null };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── AUTHORIZATION GATE ────────────────────────────────────────────
    // The handler uses a service-role client (bypasses RLS). We MUST
    // verify the caller is an active member of the requested organization
    // before returning any report data.
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
    const targetOrgId: string | undefined = body?.organizationId;

    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "unauthorized: missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!targetOrgId) {
      return new Response(
        JSON.stringify({ error: "organizationId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let callerUserId: string | null = null;
    let callerUserName: string | null = null;

    // Cron / server-to-server calls present the service role key — allow.
    if (bearer && bearer === serviceKey) {
      // trusted server caller; no user identity to record
    } else {
      const { data: userData, error: userErr } = await supabase.auth.getUser(bearer);
      if (userErr || !userData?.user) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      callerUserId = userData.user.id;
      const meta = (userData.user.user_metadata ?? {}) as Record<string, unknown>;
      callerUserName =
        (meta.full_name as string) || (meta.name as string) || userData.user.email || null;

      // Verify membership in the requested organization.
      const { data: roleRow } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("user_id", callerUserId)
        .eq("organization_id", targetOrgId)
        .eq("is_active", true)
        .maybeSingle();

      if (!roleRow) {
        return new Response(
          JSON.stringify({ error: "forbidden: not a member of this organization" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Business-level scope gate. Organization membership alone is NOT
      // sufficient: a tenant can hold several businesses and a user may be
      // entitled to only some of them. `finance_can_read_scope` is evaluated
      // as the CALLER (anon key + caller JWT), never as service_role, so the
      // service-role client below can never widen the caller's entitlement.
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      const callerClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: canRead, error: scopeErr } = await callerClient.rpc(
        "finance_can_read_scope",
        { _org_id: targetOrgId, _business_id: body?.businessId ?? null },
      );
      if (scopeErr || canRead !== true) {
        return new Response(
          JSON.stringify({ error: "forbidden: not authorized for this business" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const caller = { userId: callerUserId, userName: callerUserName };



    // ── PREBUILT mode ─────────────────────────────────────────────────
    // Page already produced columns + rows (e.g. from ReportExportService).
    // We still apply central branding, format profile, and audit.
    if (Array.isArray(body?.rows) && Array.isArray(body?.columns)) {
      const {
        columns,
        rows,
        organizationId,
        businessId,
        reportType,
        title,
        dateRange,
        orientation,
        currency,
        recipientInfo,
        amountDue,
        summaryRows,
        footerNote,
        subtitle,
        paperFormat,
        branchId,
        asOf,
        formatProfile,
      } = body;

      // Milestone C.2 — tabular exports (CSV, XLSX). Same columns/rows
      // the PDF path receives so every serialization is byte-identical.
      const prebuiltFormat = (body?.format ?? "pdf") as "pdf" | "csv" | "xlsx";
      if (prebuiltFormat !== "pdf" && prebuiltFormat !== "csv" && prebuiltFormat !== "xlsx") {
        return new Response(
          JSON.stringify({ error: `Unsupported format "${prebuiltFormat}". Supported: pdf, csv, xlsx.` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (organizationId) {
        const { checkSubscriptionActive, entitlementDeniedResponse } = await import(
          "../_shared/entitlementCheck.ts"
        );
        const subResult = await checkSubscriptionActive(supabase, organizationId);
        if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
      }

      const safeTitle = (title || reportType || "Report").replace(/[^a-zA-Z0-9_-]/g, "_");

      // Safety net: a caller that ships rows with an empty column list
      // (the exact shape that produced blank payroll exports) still gets
      // the registry projection rather than a headerless artifact.
      const effectiveColumns = resolveReportColumns({
        reportType,
        explicit: columns,
        rows,
      });

      // Tabular exports short-circuit here — never touch the PDF renderer.
      if (prebuiltFormat === "csv" || prebuiltFormat === "xlsx") {
        // Resolve the company name from the canonical branding path so
        // the CSV/XLSX masthead matches the PDF masthead exactly.
        let companyName: string | undefined;
        if (organizationId) {
          try {
            const { getOrganizationBranding } = await import("../_shared/branding/index.ts");
            const branding = await getOrganizationBranding(supabase, organizationId);
            companyName = branding?.name ?? undefined;
          } catch (err) {
            console.warn("[render-report] branding lookup failed for export:", (err as Error).message);
          }
        }

        const exportConfig = {
          title: title ?? safeTitle,
          subtitle,
          dateRange,
          companyName,
          currency,
          columns: effectiveColumns,
          rows,
          generatedAt: new Date().toISOString(),
        };

        if (prebuiltFormat === "csv") {
          const { buildReportCsv } = await import("../_shared/exports/reportCsv.ts");
          const csvBytes = buildReportCsv(exportConfig);
          await logReportRun(supabase, {
            organizationId,
            businessId,
            userId: caller.userId,
            reportType,
            outputFormat: "csv",
            params: { dateRange, branchId: branchId ?? null, mode: "prebuilt" },
            rowCount: Array.isArray(rows) ? rows.length : 0,
            byteCount: csvBytes.length,
          });
          return new Response(csvBytes as unknown as BodyInit, {
            headers: {
              ...corsHeaders,
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${safeTitle}.csv"`,
            },
          });
        }

        const { buildReportXlsx, XLSX_MIME } = await import("../_shared/exports/reportXlsx.ts");
        const xlsxBytes = buildReportXlsx(exportConfig);
        await logReportRun(supabase, {
          organizationId,
          businessId,
          userId: caller.userId,
          reportType,
          outputFormat: "xlsx",
          params: { dateRange, branchId: branchId ?? null, mode: "prebuilt" },
          rowCount: Array.isArray(rows) ? rows.length : 0,
          byteCount: xlsxBytes.length,
        });
        return new Response(xlsxBytes as unknown as BodyInit, {
          headers: {
            ...corsHeaders,
            "Content-Type": XLSX_MIME,
            "Content-Disposition": `attachment; filename="${safeTitle}.xlsx"`,
          },
        });
      }

      const pdfBytes = await renderReport(supabase, {
        organizationId,
        businessId,
        reportType,
        columns: effectiveColumns,
        rows,
        title,
        subtitle,
        dateRange,
        asOf,
        formatProfile,
        orientation,
        currency,
        recipientInfo,
        amountDue,
        summaryRows,
        footerNote,
        userId: caller.userId,
        userName: caller.userName,
        params: { mode: "prebuilt", title, dateRange },
        paperFormat,
        branchId,
      });

      return new Response(pdfBytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeTitle}.pdf"`,
        },
      });
    }

    // ── SERVER-BUILD mode ─────────────────────────────────────────────
    const {
      reportType,
      organizationId,
      businessId,
      dateFrom,
      dateTo,
      title,
      format = "pdf",
    } = body as {
      reportType: ReportType;
      organizationId: string;
      businessId?: string;
      dateFrom: string;
      dateTo: string;
      title?: string;
      format?: "pdf" | "json" | "csv" | "xlsx";
    };

    if (!reportType || !organizationId || !dateFrom || !dateTo) {
      return new Response(
        JSON.stringify({
          error: "reportType, organizationId, dateFrom, dateTo are required (or pass {columns, rows} for prebuilt mode)",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { checkSubscriptionActive, entitlementDeniedResponse } = await import(
      "../_shared/entitlementCheck.ts"
    );
    const subResult = await checkSubscriptionActive(supabase, organizationId);
    if (!subResult.allowed) {
      return entitlementDeniedResponse(subResult, corsHeaders);
    }

    const isAttendance = (
      [
        "attendance_daily_log",
        "attendance_late_arrivals",
        "attendance_absences",
        "attendance_payroll_ready",
        "attendance_period_summary",
      ] as const
    ).includes(reportType as AttendanceReportKey);

    const isPayroll = (
      [
        "payroll_register",
        "payroll_summary",
        "employer_contributions",
        "statutory_liabilities",
        "employee_earnings",
        "branch_payroll_cost",
        "department_payroll_cost",
        "payroll_overtime",
        "payroll_variance",
      ] as const
    ).includes(reportType as PayrollReportKey);

    const isPayrollExtended = (
      [
        "payroll_gl_posting",
        "payroll_audit_trail",
        "payroll_work_entries",
      ] as const
    ).includes(reportType as PayrollExtendedReportKey);

    const isProject = typeof reportType === "string" && reportType.startsWith("project_");

    const isInventory = (
      [
        "stock_ledger",
        "inventory_valuation",
        "inventory_aging",
        "inventory_gl_reconciliation",
        "lot_traceability",
      ] as const
    ).includes(reportType as InventoryReportKey);



    const result = isAttendance
      ? await buildAttendanceReport(
          supabase,
          reportType as AttendanceReportKey,
          organizationId,
          businessId,
          dateFrom,
          dateTo,
          (body?.filters ?? {}) as AttendanceFilters,
        )
      : isPayroll
      ? await buildPayrollReport(
          supabase,
          reportType as PayrollReportKey,
          organizationId,
          businessId,
          dateFrom,
          dateTo,
          (body?.filters ?? {}) as PayrollFilters,
        )
      : isPayrollExtended
      ? await buildPayrollExtendedReport(
          supabase,
          reportType as PayrollExtendedReportKey,
          organizationId,
          businessId,
          dateFrom,
          dateTo,
          (body?.filters ?? {}) as PayrollExtendedFilters,
        )
      : isProject
      ? await buildProjectReport(
          supabase,
          reportType as ProjectReportKey,
          organizationId,
          businessId,
          dateFrom,
          dateTo,
          (body?.filters ?? {}) as ProjectFilters,
        )
      : isInventory
      ? await buildInventoryReport(
          supabase,
          reportType as InventoryReportKey,
          organizationId,
          businessId,
          dateFrom,
          dateTo,
          (body?.filters ?? {}) as InventoryFilters,
        )

      : await buildReportData(
          supabase,
          reportType as Exclude<ReportType, AttendanceReportKey>,
          organizationId,
          businessId,
          dateFrom,
          dateTo,
          (body as { branchId?: string | null }).branchId ?? undefined,
          (body?.filters ?? {}) as Record<string, unknown>,
        );


    if (format === "json") {
      // Column projection belongs to the REPORT RESULT, not to the PDF
      // renderer. Without this the screen received rows with no column
      // spec and rendered an empty grid under a "Rows: N" band, while
      // the PDF of the identical result was correct.
      const columns = resolveReportColumns({
        reportType,
        fromResult:
          (result as { columns?: unknown[] }).columns as
            | Parameters<typeof resolveReportColumns>[0]["fromResult"]
          ?? null,
        rows: result.data as Parameters<typeof resolveReportColumns>[0]["rows"],
      });
      // Viewing a report IS a report run. Without this the audit trail only
      // knew about PDFs, so "who saw these payroll figures?" was unanswerable.
      await logReportRun(supabase, {
        organizationId,
        businessId,
        userId: caller.userId,
        reportType,
        outputFormat: "json",
        params: { dateFrom, dateTo, filters: body?.filters ?? null },
        rowCount: Array.isArray(result.data) ? result.data.length : 0,
      });
      return new Response(
        JSON.stringify({
          reportType,
          dateRange: { from: dateFrom, to: dateTo },
          ...result,
          columns,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Tabular exports from a SERVER-BUILD request. CSV/XLSX must be
    // regenerated from the same builder + period the screen used, never
    // re-shipped from the browser's (paginated, permission-masked) rows —
    // otherwise a 5,000-row register exports as the 50 rows on screen.
    if (format === "csv" || format === "xlsx") {
      const exportColumns = resolveReportColumns({
        reportType,
        fromResult:
          (result as { columns?: unknown[] }).columns as
            | Parameters<typeof resolveReportColumns>[0]["fromResult"]
          ?? null,
        rows: result.data as Parameters<typeof resolveReportColumns>[0]["rows"],
      });

      let companyName: string | undefined;
      try {
        const { getOrganizationBranding } = await import("../_shared/branding/index.ts");
        companyName = (await getOrganizationBranding(supabase, organizationId))?.name ?? undefined;
      } catch (err) {
        console.warn("[render-report] branding lookup failed for export:", (err as Error).message);
      }

      const reportTitle = title || getReportTitle(reportType) || "Report";
      const exportName = reportTitle.replace(/[^a-zA-Z0-9_-]/g, "_");
      const exportConfig = {
        title: reportTitle,
        dateRange: `${dateFrom} to ${dateTo}`,
        companyName,
        columns: exportColumns,
        rows: result.data as Record<string, unknown>[],
        generatedAt: new Date().toISOString(),
      };

      if (format === "csv") {
        const { buildReportCsv } = await import("../_shared/exports/reportCsv.ts");
        const csvBytes = buildReportCsv(exportConfig);
        await logReportRun(supabase, {
          organizationId,
          businessId,
          userId: caller.userId,
          reportType,
          outputFormat: "csv",
          params: { dateFrom, dateTo, filters: body?.filters ?? null },
          rowCount: Array.isArray(result.data) ? result.data.length : 0,
          byteCount: csvBytes.length,
        });
        return new Response(csvBytes as unknown as BodyInit, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${exportName}.csv"`,
          },
        });
      }

      const { buildReportXlsx, XLSX_MIME } = await import("../_shared/exports/reportXlsx.ts");
      const xlsxBytes = buildReportXlsx(exportConfig);
      await logReportRun(supabase, {
        organizationId,
        businessId,
        userId: caller.userId,
        reportType,
        outputFormat: "xlsx",
        params: { dateFrom, dateTo, filters: body?.filters ?? null },
        rowCount: Array.isArray(result.data) ? result.data.length : 0,
        byteCount: xlsxBytes.length,
      });
      return new Response(xlsxBytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          "Content-Type": XLSX_MIME,
          "Content-Disposition": `attachment; filename="${exportName}.xlsx"`,
        },
      });
    }

    const pdfBytes = await renderReport(supabase, {
      organizationId,
      businessId,
      reportType,
      title,
      dateRange: `${dateFrom} to ${dateTo}`,
      rows: result.data as Parameters<typeof renderReport>[1]["rows"],
      // Ledger builders widen their own columns when the run contains a
      // foreign-currency line; the registry spec stands in otherwise.
      columns: (result as { columns?: Parameters<typeof renderReport>[1]["columns"] }).columns,

      userId: caller.userId,
      userName: caller.userName,
      params: { mode: "server-build", dateFrom, dateTo },
      paperFormat: (body as { paperFormat?: "a4" | "letter" | "a5" }).paperFormat,
      branchId: (body as { branchId?: string | null }).branchId ?? null,
    });

    const safeTitle = (title || getReportTitle(reportType) || "report").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );

    return new Response(pdfBytes as unknown as BodyInit, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeTitle}.pdf"`,
      },
    });
  } catch (error) {
    console.error("render-report error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
