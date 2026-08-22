import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";
import { renderReport, getReportSpec } from "../_shared/reports/index.ts";
import type { ReportRow } from "../_shared/reportPdfGenerator.ts";
import {
  buildBalanceSheet,
  buildTrialBalance,
  buildIncomeStatement,
  buildCashFlow,
  buildGeneralLedger,
  buildPartnerLedger,
  buildJournalReport,
  buildBudgetVsActual,
  buildDepreciationSchedule,
  buildAuditTrail,
  type ReportResult,
} from "../_shared/reportDataEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ScheduledReport {
  id: string;
  organization_id: string;
  template_id: string | null;
  name: string;
  report_type: string;
  schedule_type: string;
  schedule_config: {
    day_of_week?: number;
    day_of_month?: number;
    time_of_day?: string;
  };
  recipients: Array<{ email: string; name?: string }>;
  format: string;
  include_charts: boolean;
  date_range_type: string;
  filters: Record<string, unknown>;
  is_active: boolean;
  business_id?: string | null;
  branch_id?: string | null;
}

interface ReportData {
  title: string;
  generatedAt: string;
  dateRange: { start: string; end: string };
  data: Record<string, unknown>[];
  summary: Record<string, unknown>;
  reportType: string;
}

/**
 * The branch a schedule is scoped to, or `undefined` for the whole business.
 * `branch_id` is authoritative; `filters.branchId` is the pre-column form and
 * is only read as a fallback so old schedules keep the scope they were saved
 * with.
 */
function resolveScheduleBranch(report: ScheduledReport): string | undefined {
  const legacy = (report.filters?.branchId ?? report.filters?.branch_id) as string | undefined;
  return (report.branch_id || legacy) || undefined;
}

// (Branding fallback removed in Stage K — renderReport handles the lookup
// internally and tolerates a missing record without producing a broken PDF.)

// ── Scheduling Helpers ─────────────────────────────────────────────────

function calculateDateRange(dateRangeType: string): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  let start = new Date(now);

  switch (dateRangeType) {
    case "last_7_days":
      start.setDate(start.getDate() - 7);
      break;
    case "last_30_days":
      start.setDate(start.getDate() - 30);
      break;
    case "this_month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "last_month":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end.setDate(0);
      break;
    case "this_quarter": {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), currentQuarter * 3, 1);
      break;
    }
    case "last_quarter": {
      const lastQuarter = Math.floor(now.getMonth() / 3) - 1;
      const yearOffset = lastQuarter < 0 ? -1 : 0;
      const adjustedQuarter = lastQuarter < 0 ? 3 : lastQuarter;
      start = new Date(now.getFullYear() + yearOffset, adjustedQuarter * 3, 1);
      end.setMonth(adjustedQuarter * 3 + 3);
      end.setDate(0);
      break;
    }
    case "this_year":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case "last_year":
      start = new Date(now.getFullYear() - 1, 0, 1);
      end.setFullYear(end.getFullYear() - 1);
      end.setMonth(11);
      end.setDate(31);
      break;
    default:
      start.setDate(start.getDate() - 30);
  }

  return { start, end };
}

function calculateNextSendAt(
  scheduleType: string,
  scheduleConfig: ScheduledReport["schedule_config"]
): string {
  const now = new Date();
  const next = new Date(now);

  switch (scheduleType) {
    case "every_1_min":
      next.setMinutes(next.getMinutes() + 1);
      return next.toISOString();
    case "every_5_min":
      next.setMinutes(next.getMinutes() + 5);
      return next.toISOString();
    case "every_15_min":
      next.setMinutes(next.getMinutes() + 15);
      return next.toISOString();
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly": {
      const dayOfWeek = scheduleConfig.day_of_week ?? 1;
      const daysUntilNext = (dayOfWeek - now.getDay() + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntilNext);
      break;
    }
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      if (scheduleConfig.day_of_month) {
        next.setDate(Math.min(scheduleConfig.day_of_month, 28));
      }
      break;
    case "quarterly":
      next.setMonth(next.getMonth() + 3);
      break;
  }

  if (scheduleConfig.time_of_day) {
    const [hours, minutes] = scheduleConfig.time_of_day.split(":").map(Number);
    next.setHours(hours, minutes, 0, 0);
  } else {
    next.setHours(8, 0, 0, 0);
  }

  return next.toISOString();
}

// ── Report Data Generation (delegates to shared engine) ────────────────

async function generateReportData(
  supabase: SupabaseClient,
  report: ScheduledReport,
  dateRange: { start: Date; end: Date }
): Promise<ReportData> {
  const { start, end } = dateRange;
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  let result: ReportResult;
  const businessId = (report.business_id || report.filters?.businessId || report.filters?.business_id) as string | undefined;
  // A schedule states its own scope. `branch_id` is the stored scope; the
  // legacy `filters.branchId` is honoured for schedules created before the
  // column existed. NULL still means "the whole business" — the engines
  // treat an undefined branch as unscoped, exactly as the screens do.
  const branchId = resolveScheduleBranch(report);

  switch (report.report_type) {
    // ── Financial reports via shared engine ──
    case "balance_sheet":
      result = await buildBalanceSheet(supabase, report.organization_id, businessId, startStr, endStr);
      break;
    case "trial_balance":
      result = await buildTrialBalance(supabase, report.organization_id, businessId, startStr, endStr, branchId);
      break;
    case "income_statement":
    case "profit_and_loss":
      result = await buildIncomeStatement(supabase, report.organization_id, businessId, startStr, endStr);
      break;
    case "cash_flow":
      result = await buildCashFlow(supabase, report.organization_id, businessId, startStr, endStr, branchId);
      break;
    case "general_ledger":
      result = await buildGeneralLedger(supabase, report.organization_id, businessId, startStr, endStr, branchId);
      break;
    case "partner_ledger":
      result = await buildPartnerLedger(supabase, report.organization_id, businessId, startStr, endStr, branchId);
      break;
    case "journal_report":
      result = await buildJournalReport(supabase, report.organization_id, businessId, startStr, endStr, branchId);
      break;
    case "budget_vs_actual":
      result = await buildBudgetVsActual(supabase, report.organization_id, businessId, startStr, endStr);
      break;
    case "depreciation_schedule":
      result = await buildDepreciationSchedule(supabase, report.organization_id);
      break;
    case "audit_trail":
      result = await buildAuditTrail(supabase, report.organization_id, startStr, endStr);
      break;

    // ── Operational reports (simple queries, no shared engine needed) ──
    case "aged_payables":
      result = await buildAgedPayables(supabase, report.organization_id, endStr);
      break;
    case "invoice_aging":
      result = await buildInvoiceAging(supabase, report.organization_id, endStr);
      break;
    case "sales_summary":
      result = await buildSalesSummary(supabase, report.organization_id, startStr, endStr);
      break;
    case "customer_analysis":
      result = await buildCustomerAnalysis(supabase, report.organization_id);
      break;
    case "stock_report":
      result = await buildStockReport(supabase, report.organization_id);
      break;
    case "tax_report":
      result = await buildTaxReport(supabase, report.organization_id, startStr, endStr);
      break;
    case "expense_report":
      result = await buildExpenseReport(supabase, report.organization_id, startStr, endStr);
      break;
    case "purchase_orders_report":
      result = await buildPurchaseOrdersReport(supabase, report.organization_id, startStr, endStr);
      break;
    case "crm_pipeline_report":
      result = await buildCrmPipelineReport(supabase, report.organization_id);
      break;
    case "contacts_directory":
      result = await buildContactsDirectory(supabase, report.organization_id);
      break;
    default:
      result = { data: [], summary: { message: "Unknown report type" } };
  }

  return {
    title: report.name,
    generatedAt: new Date().toISOString(),
    dateRange: { start: startStr, end: endStr },
    data: result.data,
    summary: result.summary,
    reportType: report.report_type,
  };
}

// ── Operational Report Builders (lightweight, no duplication risk) ──────

async function buildAgedPayables(supabase: SupabaseClient, orgId: string, endStr: string): Promise<ReportResult> {
  const { data: bills } = await supabase
    .from("bills")
    .select("id, bill_number, bill_date, due_date, total, amount_paid, status, vendor_id")
    .eq("organization_id", orgId)
    .in("status", ["pending", "approved", "overdue", "partial"])
    .lte("bill_date", endStr);

  const agingData = ((bills || []) as Record<string, unknown>[]).map(bill => {
    const total = (bill.total as number) || 0;
    const amountPaid = (bill.amount_paid as number) || 0;
    const balanceDue = total - amountPaid;
    const dueDate = new Date(bill.due_date as string);
    const today = new Date(endStr);
    const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    let bucket = "current";
    if (daysOverdue > 90) bucket = "90+";
    else if (daysOverdue > 60) bucket = "61-90";
    else if (daysOverdue > 30) bucket = "31-60";
    return { ...bill, balance_due: balanceDue, days_overdue: Math.max(0, daysOverdue), bucket };
  }).filter(b => (b.balance_due as number) > 0);

  const currentBucket = agingData.filter(i => i.bucket === "current").reduce((s: number, i) => s + (i.balance_due as number), 0);
  const bucket30 = agingData.filter(i => i.bucket === "31-60").reduce((s: number, i) => s + (i.balance_due as number), 0);
  const bucket60 = agingData.filter(i => i.bucket === "61-90").reduce((s: number, i) => s + (i.balance_due as number), 0);
  const bucket90 = agingData.filter(i => i.bucket === "90+").reduce((s: number, i) => s + (i.balance_due as number), 0);

  return {
    data: agingData,
    summary: { totalBills: agingData.length, current: currentBucket, "31-60_days": bucket30, "61-90_days": bucket60, "90+_days": bucket90, totalOutstanding: currentBucket + bucket30 + bucket60 + bucket90 },
  };
}

async function buildInvoiceAging(supabase: SupabaseClient, orgId: string, endStr: string): Promise<ReportResult> {
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, issue_date, due_date, total, amount_paid, status, contact_id")
    .eq("organization_id", orgId)
    .in("status", ["sent", "overdue", "partial"])
    .lte("issue_date", endStr);

  const agingData = ((invoices || []) as Record<string, unknown>[]).map(inv => {
    const total = (inv.total as number) || 0;
    const amountPaid = (inv.amount_paid as number) || 0;
    const balanceDue = total - amountPaid;
    const dueDate = new Date(inv.due_date as string);
    const today = new Date(endStr);
    const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    let bucket = "current";
    if (daysOverdue > 90) bucket = "90+";
    else if (daysOverdue > 60) bucket = "61-90";
    else if (daysOverdue > 30) bucket = "31-60";
    return { ...inv, balance_due: balanceDue, days_overdue: Math.max(0, daysOverdue), bucket };
  }).filter(inv => (inv.balance_due as number) > 0);

  const currentBucket = agingData.filter(i => i.bucket === "current").reduce((s: number, i) => s + (i.balance_due as number), 0);
  const bucket30 = agingData.filter(i => i.bucket === "31-60").reduce((s: number, i) => s + (i.balance_due as number), 0);
  const bucket60 = agingData.filter(i => i.bucket === "61-90").reduce((s: number, i) => s + (i.balance_due as number), 0);
  const bucket90 = agingData.filter(i => i.bucket === "90+").reduce((s: number, i) => s + (i.balance_due as number), 0);

  return {
    data: agingData,
    summary: { totalInvoices: agingData.length, current: currentBucket, "31-60_days": bucket30, "61-90_days": bucket60, "90+_days": bucket90, totalOutstanding: currentBucket + bucket30 + bucket60 + bucket90 },
  };
}

async function buildSalesSummary(supabase: SupabaseClient, orgId: string, startStr: string, endStr: string): Promise<ReportResult> {
  const { data: invoices } = await supabase
    .from("invoices")
    .select("*")
    .eq("organization_id", orgId)
    .in("status", ["sent", "paid", "overdue", "partial"])
    .gte("issue_date", startStr)
    .lte("issue_date", endStr);

  const data = invoices || [];
  const salesTotal = data.reduce((sum: number, inv: Record<string, unknown>) => sum + ((inv.total as number) || 0), 0);
  const salesPaid = data.reduce((sum: number, inv: Record<string, unknown>) => sum + ((inv.amount_paid as number) || 0), 0);

  return {
    data,
    summary: { totalInvoices: data.length, totalAmount: salesTotal, amountPaid: salesPaid, amountOutstanding: salesTotal - salesPaid },
  };
}

async function buildCustomerAnalysis(supabase: SupabaseClient, orgId: string): Promise<ReportResult> {
  const { data: contacts } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", orgId)
    .or("customer_rank.gt.0,type.eq.customer,type.eq.both");

  const data = contacts || [];
  return {
    data,
    summary: { totalCustomers: data.length, activeCustomers: data.filter((c: Record<string, unknown>) => c.is_active).length },
  };
}

async function buildStockReport(supabase: SupabaseClient, orgId: string): Promise<ReportResult> {
  const { data: products } = await supabase
    .from("products")
    .select("*")
    .eq("organization_id", orgId)
    .eq("is_active", true);

  const data = products || [];
  const totalValue = data.reduce(
    (sum: number, p: Record<string, unknown>) => sum + ((p.stock_quantity as number) || 0) * ((p.unit_price as number) || 0),
    0
  );

  return {
    data,
    summary: {
      totalProducts: data.length,
      totalStockValue: totalValue,
      lowStockItems: data.filter((p: Record<string, unknown>) => ((p.stock_quantity as number) || 0) <= ((p.reorder_level as number) || 0)).length,
    },
  };
}

async function buildTaxReport(supabase: SupabaseClient, orgId: string, startStr: string, endStr: string): Promise<ReportResult> {
  const { data: invoices } = await supabase
    .from("invoices")
    .select("tax_amount, total")
    .eq("organization_id", orgId)
    .in("status", ["sent", "paid", "overdue", "partial"])
    .gte("issue_date", startStr)
    .lte("issue_date", endStr);

  const data = invoices || [];
  const totalTax = data.reduce((sum: number, inv: Record<string, unknown>) => sum + ((inv.tax_amount as number) || 0), 0);

  return { data, summary: { totalInvoices: data.length, totalTaxCollected: totalTax } };
}

async function buildExpenseReport(supabase: SupabaseClient, orgId: string, startStr: string, endStr: string): Promise<ReportResult> {
  const { data: expenses } = await supabase
    .from("expenses")
    .select("id, expense_date, description, amount, tax_amount, status, category_id, vendor_id, payment_method, reference, expense_categories(name), contacts(name)")
    .eq("organization_id", orgId)
    .gte("expense_date", startStr)
    .lte("expense_date", endStr)
    .order("expense_date", { ascending: false });

  const data = ((expenses || []) as Record<string, unknown>[]).map(e => {
    const cat = e.expense_categories as Record<string, unknown> | null;
    const vendor = e.contacts as Record<string, unknown> | null;
    return {
      date: e.expense_date, description: e.description || "", category: cat?.name || "",
      vendor: vendor?.name || "", amount: (e.amount as number) || 0, tax: (e.tax_amount as number) || 0,
      status: e.status || "", payment_method: e.payment_method || "", reference: e.reference || "",
    };
  });

  const totalAmount = data.reduce((s: number, d) => s + ((d.amount as number) || 0), 0);
  const totalTax = data.reduce((s: number, d) => s + ((d.tax as number) || 0), 0);

  return { data, summary: { totalExpenses: data.length, totalAmount, totalTax, grandTotal: totalAmount + totalTax } };
}

async function buildPurchaseOrdersReport(supabase: SupabaseClient, orgId: string, startStr: string, endStr: string): Promise<ReportResult> {
  const { data: pos } = await supabase
    .from("purchase_orders")
    .select("id, po_number, order_date, expected_date, status, subtotal, tax_amount, total, vendor_id, contacts(name)")
    .eq("organization_id", orgId)
    .gte("order_date", startStr)
    .lte("order_date", endStr)
    .order("order_date", { ascending: false });

  const data = ((pos || []) as Record<string, unknown>[]).map(po => {
    const vendor = po.contacts as Record<string, unknown> | null;
    return {
      po_number: po.po_number, order_date: po.order_date, expected_date: po.expected_date || "",
      vendor: vendor?.name || "", status: po.status || "",
      subtotal: (po.subtotal as number) || 0, tax: (po.tax_amount as number) || 0, total: (po.total as number) || 0,
    };
  });

  const totalValue = data.reduce((s: number, d) => s + ((d.total as number) || 0), 0);
  return { data, summary: { totalOrders: data.length, totalValue } };
}

async function buildCrmPipelineReport(supabase: SupabaseClient, orgId: string): Promise<ReportResult> {
  const { data: leads } = await supabase
    .from("crm_leads")
    .select("id, name, contact_name, company_name, expected_revenue, probability, stage_id, won_at, lost_at, created_at, crm_stages(name)")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const data = ((leads || []) as Record<string, unknown>[]).map(l => {
    const stage = l.crm_stages as Record<string, unknown> | null;
    return {
      name: l.name, contact: l.contact_name || "", company: l.company_name || "",
      stage: stage?.name || "", expected_revenue: (l.expected_revenue as number) || 0,
      probability: (l.probability as number) || 0,
      weighted_value: ((l.expected_revenue as number) || 0) * ((l.probability as number) || 0) / 100,
      status: l.won_at ? "Won" : l.lost_at ? "Lost" : "Open",
    };
  });

  const totalPipeline = data.reduce((s: number, d) => s + ((d.expected_revenue as number) || 0), 0);
  const weightedPipeline = data.reduce((s: number, d) => s + ((d.weighted_value as number) || 0), 0);

  return {
    data,
    summary: { totalLeads: data.length, totalPipelineValue: totalPipeline, weightedPipelineValue: weightedPipeline, wonDeals: data.filter(d => d.status === "Won").length },
  };
}

async function buildContactsDirectory(supabase: SupabaseClient, orgId: string): Promise<ReportResult> {
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, name, company, type, email, phone, city, country, is_active")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  const data = ((contacts || []) as Record<string, unknown>[]).map(c => ({
    name: c.name, company: c.company || "", type: c.type || "",
    email: c.email || "", phone: c.phone || "", city: c.city || "", country: c.country || "",
  }));

  const customers = data.filter(c => c.type === "customer" || c.type === "both").length;
  const suppliers = data.filter(c => c.type === "supplier" || c.type === "both").length;

  return { data, summary: { totalContacts: data.length, customers, suppliers } };
}

// ── Column Configs ─────────────────────────────────────────────────────
//
// Column specifications used to live inline here as a 160-line map. They
// have been moved to `_shared/reports/columnSpecs.ts` so this endpoint
// and `render-report` always agree on what a given report looks like.
// `generatePDFReport` below now reads from the registry indirectly via
// the `renderReport` funnel.


// ── Row Transformation ─────────────────────────────────────────────────

function transformReportDataToRows(reportData: ReportData): ReportRow[] {
  return reportData.data.map((row) => {
    const transformed: ReportRow = {};
    for (const [key, val] of Object.entries(row)) {
      if (key.startsWith("_")) {
        transformed[key] = val as string | number | boolean | null | undefined;
        continue;
      }
      if (key === "is_active") {
        transformed[key] = val ? "Yes" : "No";
      } else if (typeof val === "string" && val.match(/^\d{4}-\d{2}-\d{2}/)) {
        transformed[key] = val.split("T")[0];
      } else {
        transformed[key] = val as string | number | boolean | null | undefined;
      }
    }
    if ("total" in row && "amount_paid" in row) {
      transformed["outstanding"] = ((row.total as number) || 0) - ((row.amount_paid as number) || 0);
    }
    if ("stock_quantity" in row && "unit_price" in row) {
      transformed["total_value"] = ((row.stock_quantity as number) || 0) * ((row.unit_price as number) || 0);
    }
    return transformed;
  });
}

// ── Tabular exports (CSV / XLSX) ───────────────────────────────────────
//
// The delivered spreadsheet is the same document as the PDF: same column
// registry, same headers, same order. The previous local serializer read
// raw row keys, so a scheduled CSV carried database column names the
// on-screen report never shows — and an "excel" schedule attached CSV
// bytes under an .xlsx name, which Excel refuses to open.

function buildTabularAttachment(
  reportData: ReportData,
  format: "csv" | "excel",
): { bytes: Uint8Array; extension: string } {
  const rows = transformReportDataToRows(reportData);
  const spec = getReportSpec(reportData.reportType);
  const columns = resolveReportColumns({
    reportType: reportData.reportType,
    fromResult: spec?.columns ?? null,
    rows,
  });

  const config: ReportExportConfig = {
    title: reportData.title,
    dateRange: `${reportData.dateRange.start} to ${reportData.dateRange.end}`,
    columns: columns as ReportExportConfig["columns"],
    rows: rows as ReportExportConfig["rows"],
    generatedAt: reportData.generatedAt,
  };

  return format === "excel"
    ? { bytes: buildReportXlsx(config), extension: "xlsx" }
    : { bytes: buildReportCsv(config), extension: "csv" };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── Org Branding ───────────────────────────────────────────────────────
//
// Removed in Stage K: the local fetchOrganizationBranding() wrapper used
// to hand-build a fallback OrgBranding object. `renderReport` now resolves
// branding internally via the centralized getOrganizationBranding() helper,
// eliminating the duplicate code path.

// ── PDF Generation ─────────────────────────────────────────────────────
//
// All PDF generation flows through the unified `renderReport` funnel.
// Column shape, orientation, and default title are sourced from the
// per-report registry, guaranteeing scheduled reports look identical
// to the live UI render of the same report.

async function generatePDFReport(
  supabase: SupabaseClient,
  reportData: ReportData,
  organizationId: string,
): Promise<Uint8Array> {
  const rows = transformReportDataToRows(reportData);
  const spec = getReportSpec(reportData.reportType);

  return await renderReport(supabase, {
    organizationId,
    reportType: reportData.reportType,
    title: reportData.title,
    dateRange: `${reportData.dateRange.start} to ${reportData.dateRange.end}`,
    rows,
    orientation: spec?.orientation ?? "landscape",
  });
}

// ── Email Sending ──────────────────────────────────────────────────────

async function sendReportEmail(
  supabase: SupabaseClient,
  report: ScheduledReport,
  reportData: ReportData,
  format: string,
): Promise<{ success: boolean; sentTo: string[] }> {
  const sentTo: string[] = [];
  const subject = `${report.name} - ${reportData.dateRange.start} to ${reportData.dateRange.end}`;
  const reportFileName = report.name.replace(/\s+/g, "_");

  // Resolve org name once for the email shell. Failure here is non-fatal —
  // we fall back to the platform name. The PDF itself uses branding via
  // renderReport, which has its own resilient lookup.
  let orgName = "AccrualFlow";
  try {
    const { data } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", report.organization_id)
      .maybeSingle();
    if (data?.name) orgName = data.name;
  } catch (e) {
    console.warn("Org name lookup failed (using default):", (e as Error).message);
  }

  let attachments: Array<{ filename: string; content: string; encoding: string }> | undefined;
  let body: string;

  const headerHtml = `
    <div style="background: #213d87; padding: 20px 24px; border-radius: 8px 8px 0 0;">
      <h2 style="color: #ffffff; margin: 0; font-size: 18px;">${orgName}</h2>
    </div>`;

  const footerHtml = `
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;" />
    <p style="color: #999; font-size: 12px;">This is an automated report generated by ${orgName}.</p>`;

  if (format === "pdf") {
    const pdfBytes = await generatePDFReport(supabase, reportData, report.organization_id);
    const pdfBase64 = toBase64(pdfBytes);

    attachments = [{ filename: `${reportFileName}.pdf`, content: pdfBase64, encoding: "base64" }];

    body = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${headerHtml}
        <div style="background: #f8f9fb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <h3 style="color: #1a1a2e; margin-top: 0;">${report.name}</h3>
          <p style="color: #555; font-size: 14px;">
            Your scheduled report for the period <strong>${reportData.dateRange.start}</strong> to <strong>${reportData.dateRange.end}</strong> is ready.
          </p>
          <p style="color: #555; font-size: 14px;">Please find the detailed report attached as a PDF document.</p>
          ${footerHtml}
        </div>
      </div>`;
  } else if (format === "csv" || format === "excel") {
    const csvContent = formatAsCSV(reportData);
    const csvBase64 = btoa(csvContent);
    const ext = format === "excel" ? "xlsx" : "csv";

    attachments = [{ filename: `${reportFileName}.${ext}`, content: csvBase64, encoding: "base64" }];

    body = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${headerHtml}
        <div style="background: #f8f9fb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <h3 style="color: #1a1a2e; margin-top: 0;">${report.name}</h3>
          <p style="color: #555; font-size: 14px;">
            Your scheduled report for the period <strong>${reportData.dateRange.start}</strong> to <strong>${reportData.dateRange.end}</strong> is ready.
          </p>
          <p style="color: #555; font-size: 14px;">Please find the data file attached.</p>
          ${footerHtml}
        </div>
      </div>`;
  } else {
    body = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${headerHtml}
        <div style="background: #f8f9fb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <h3 style="color: #1a1a2e; margin-top: 0;">${report.name}</h3>
          <p style="color: #555; font-size: 14px;">Period: ${reportData.dateRange.start} to ${reportData.dateRange.end}</p>
          <h4 style="color: #1a1a2e;">Summary</h4>
          <ul style="color: #555; font-size: 14px;">`;

    for (const [key, value] of Object.entries(reportData.summary)) {
      const formattedKey = key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase());
      const formattedValue = typeof value === "number"
        ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : value;
      body += `<li><strong>${formattedKey}:</strong> ${formattedValue}</li>`;
    }
    body += `</ul>${footerHtml}</div></div>`;
  }

  for (const recipient of report.recipients) {
    try {
      const { error } = await supabase.functions.invoke("send-email", {
        body: {
          to: recipient.email,
          subject,
          html: body,
          attachments,
          // Tenant context so send-email resolves the From-line to the
          // business identity instead of the platform default (ADR 0023).
          category: "system_notification",
          organization_id: report.organization_id,
          template_key: "scheduled_report",
        },
      });
      if (!error) sentTo.push(recipient.email);
      else console.error(`Failed to send to ${recipient.email}:`, error);
    } catch (error) {
      console.error(`Error sending to ${recipient.email}:`, error);
    }
  }

  return { success: sentTo.length > 0, sentTo };
}

// ── Main Handler ───────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    console.log("Starting scheduled reports processing...");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let singleReportId: string | null = null;
    try {
      const body = await req.json();
      singleReportId = body?.reportId || null;
    } catch {
      // No body — process all due reports
    }

    let dueReports;
    let fetchError;

    if (singleReportId) {
      console.log(`Send Now triggered for report: ${singleReportId}`);
      const result = await supabase
        .from("scheduled_reports")
        .select("*")
        .eq("id", singleReportId)
        .single();
      dueReports = result.data ? [result.data] : [];
      fetchError = result.error;
    } else {
      const now = new Date().toISOString();
      const result = await supabase
        .from("scheduled_reports")
        .select("*")
        .eq("is_active", true)
        .lte("next_send_at", now);
      dueReports = result.data;
      fetchError = result.error;
    }

    if (fetchError) {
      throw new Error(`Failed to fetch due reports: ${fetchError.message}`);
    }

    console.log(`Found ${dueReports?.length || 0} reports due for processing`);

    const results: Array<{ reportId: string; success: boolean; error?: string }> = [];

    for (const report of (dueReports || []) as ScheduledReport[]) {
      const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, report.organization_id);
      if (!subResult.allowed) {
        console.log(`Skipping report ${report.id} for org ${report.organization_id}: ${subResult.reason}`);
        results.push({ reportId: report.id, success: false, error: `Subscription: ${subResult.reason}` });
        const nextSendAt = calculateNextSendAt(report.schedule_type, report.schedule_config);
        await supabase.from("scheduled_reports").update({
          next_send_at: nextSendAt,
          last_sent_at: new Date().toISOString(),
        }).eq("id", report.id);
        continue;
      }

      console.log(`Processing report: ${report.name} (${report.id})`);

      const { data: logEntry, error: logError } = await supabase
        .from("report_generation_logs")
        .insert({
          organization_id: report.organization_id,
          scheduled_report_id: report.id,
          template_id: report.template_id,
          report_type: report.report_type,
          status: "generating",
          parameters: {
            date_range_type: report.date_range_type,
            format: report.format,
            include_charts: report.include_charts,
          },
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (logError) {
        console.error(`Failed to create log entry for ${report.id}:`, logError);
        results.push({ reportId: report.id, success: false, error: logError.message });
        continue;
      }

      try {
        const dateRange = calculateDateRange(report.date_range_type);
        const reportData = await generateReportData(supabase, report, dateRange);

        const { success, sentTo } = await sendReportEmail(supabase, report, reportData, report.format);

        await supabase
          .from("report_generation_logs")
          .update({
            status: success ? "completed" : "failed",
            recipients_sent: sentTo.map((email) => ({ email, sent_at: new Date().toISOString() })),
            completed_at: new Date().toISOString(),
            error_message: success ? null : "Failed to send to any recipients",
          })
          .eq("id", logEntry.id);

        const nextSendAt = calculateNextSendAt(report.schedule_type, report.schedule_config);
        await supabase
          .from("scheduled_reports")
          .update({
            next_send_at: nextSendAt,
            last_sent_at: new Date().toISOString(),
          })
          .eq("id", report.id);

        console.log(`Report ${report.name} processed successfully. Next send: ${nextSendAt}`);
        results.push({ reportId: report.id, success: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error processing report ${report.id}:`, error);

        await supabase
          .from("report_generation_logs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
          })
          .eq("id", logEntry.id);

        results.push({ reportId: report.id, success: false, error: errorMessage });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log(`Processing complete. Success: ${successCount}, Failed: ${failCount}`);

    return new Response(
      JSON.stringify({ success: true, processed: results.length, successCount, failCount, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in process-scheduled-reports:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
