/**
 * Server-Side Payroll Document Generator (country-agnostic)
 *
 * Supports ONLY generic, country-agnostic payroll document types:
 *   - payslip               (single payslip PDF)
 *   - payroll_summary_pdf   (run summary PDF)
 *   - payroll_summary_excel (run summary CSV)
 *   - payroll_register      (per-employee per-line CSV)
 *   - bank_payment_file     (generic bank export CSV)
 *
 * All amounts are sourced from `payslip_lines` (rule-keyed, country-agnostic),
 * NEVER from legacy typed columns. Country-specific statutory returns are
 * produced by the country-agnostic `generate-statutory-return` function which
 * reads `localization_pack_return_templates` rows seeded by the installed
 * localization pack.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { generateReportPdf, type ReportPdfPayload } from "../_shared/reportPdfGenerator.ts";
import { getOrganizationBranding, type OrganizationBranding } from "../_shared/branding/index.ts";
import { classifyPayslipLine } from "../_shared/payslipClassifier.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type PayrollDocumentType =
  | "payslip"
  | "payroll_summary_pdf"
  | "payroll_summary_excel"
  | "payroll_register"
  | "bank_payment_file";

interface RequestBody {
  document_type: PayrollDocumentType;
  payroll_run_id: string;
  payslip_id?: string;
  bank_file_format?: string;
  company_account_number?: string;
}

interface PayslipRow {
  id: string;
  gross_pay: number;
  total_deductions: number;
  net_pay: number;
  status: string;
  employee: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string | null;
    department: { name: string | null } | null;
    job_position: { name: string | null } | null;
    bank_name: string | null;
    bank_code: string | null;
    bank_branch: string | null;
    bank_account_number: string | null;
    user_id: string | null;
  } | null;
}

/**
 * Derive the "basic" pay component from country-agnostic payslip_lines.
 * P1.2d: legacy `payslips.basic_salary` is dropped — basic now lives
 * only in lines (category === 'basic', or rule_code in {basic, basic_salary}
 * for packs that key it that way).
 */
function deriveBasic(lines: PayslipLine[]): number {
  let total = 0;
  for (const l of lines) {
    const isBasic =
      l.category === "basic" ||
      l.rule_code === "basic" ||
      l.rule_code === "basic_salary";
    if (isBasic) total += Number(l.employee_amount || 0);
  }
  return total;
}

interface PayrollRunRow {
  id: string;
  payroll_number: string;
  pay_period_start: string;
  pay_period_end: string;
  payment_date: string | null;
  status: string;
  total_gross: number;
  total_other_deductions: number;
  total_net: number;
  employee_count: number;
  organization_id: string;
}

interface PayslipLine {
  payslip_id: string;
  rule_code: string;
  label: string | null;
  category: string;
  sequence: number;
  employee_amount: number;
  employer_amount: number;
}

// Category buckets are owned exclusively by `_shared/payslipClassifier.ts`.
// Never re-declare Sets of category strings here — a divergent set caused
// the PAY-0065 legal-order regression where `post_tax_deduction` lines
// were silently filtered out of the PDF. See ADR-0022 pattern.
const isEarning = (l: PayslipLine) => classifyPayslipLine(l) === "earning";
const isDeduction = (l: PayslipLine) => classifyPayslipLine(l) === "deduction";
const isEmployer = (l: PayslipLine) => classifyPayslipLine(l) === "employer_contribution";

const formatLabel = (key: string) =>
  key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function looksLikeEmailPrefix(name: string): boolean {
  const t = (name || "").trim();
  if (!t) return true;
  if (/^[a-z0-9._-]+$/.test(t) && !/\s/.test(t) && /\d/.test(t)) return true;
  return false;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function toCSV(headers: string[], rows: (string | number)[][]): string {
  const escape = (val: string | number) => `"${String(val).replace(/"/g, '""')}"`;
  return [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");
}

async function fetchPayrollRun(supabase: any, runId: string): Promise<PayrollRunRow> {
  const { data, error } = await supabase.from("payroll_runs").select("*").eq("id", runId).single();
  if (error || !data) throw new Error(`Payroll run not found: ${error?.message}`);
  return data;
}

async function fetchPayslips(supabase: any, runId: string, payslipId?: string): Promise<PayslipRow[]> {
  let q = supabase
    .from("payslips")
    .select(`
      id, gross_pay, total_deductions, net_pay, status,
      employee:employees(
        id, first_name, last_name, employee_number,
        department:departments!employees_department_id_fkey(name), job_position:job_positions(name),
        bank_name, bank_code, bank_branch, bank_account_number, user_id
      )
    `)
    .eq("payroll_run_id", runId);
  if (payslipId) q = q.eq("id", payslipId);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to fetch payslips: ${error.message}`);

  const payslips = (data || []) as PayslipRow[];
  for (const ps of payslips) {
    if (ps.employee && looksLikeEmailPrefix(ps.employee.first_name) && ps.employee.user_id) {
      const { data: profile } = await supabase
        .from("profiles").select("full_name").eq("user_id", ps.employee.user_id).maybeSingle();
      if (profile?.full_name?.trim()) {
        const parts = profile.full_name.trim().split(/\s+/);
        ps.employee.first_name = parts[0] || ps.employee.first_name;
        ps.employee.last_name = parts.slice(1).join(" ") || ps.employee.last_name;
      }
    }
  }
  return payslips;
}

async function fetchLines(supabase: any, runId: string, payslipId?: string): Promise<PayslipLine[]> {
  let q = supabase
    .from("payslip_lines")
    .select("payslip_id, rule_code, label, category, sequence, employee_amount, employer_amount")
    .eq("payroll_run_id", runId)
    .order("sequence", { ascending: true });
  if (payslipId) q = q.eq("payslip_id", payslipId);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to fetch payslip_lines: ${error.message}`);
  return (data || []) as PayslipLine[];
}

async function fetchOrgDetails(supabase: any, orgId: string) {
  const branding = await getOrganizationBranding(supabase, orgId);
  const org: any = branding ?? { name: "Company" };
  org.currency = branding?.base_currency || "USD";
  return org;
}

function linesByPayslip(lines: PayslipLine[]): Map<string, PayslipLine[]> {
  const map = new Map<string, PayslipLine[]>();
  for (const l of lines) {
    if (!map.has(l.payslip_id)) map.set(l.payslip_id, []);
    map.get(l.payslip_id)!.push(l);
  }
  return map;
}

// ── PDF: Single Payslip ─────────────────────────────────────────────────────
async function generatePayslipPdf(
  ps: PayslipRow, lines: PayslipLine[], run: PayrollRunRow, org: any,
): Promise<Uint8Array> {
  const currency = org.currency || "USD";
  const periodLabel = `${formatDate(run.pay_period_start)} - ${formatDate(run.pay_period_end)}`;
  const emp = ps.employee;
  const empName = emp ? `${emp.first_name} ${emp.last_name}`.trim() : "Unknown";

  const rows: Array<Record<string, any>> = [];
  rows.push({ description: "EMPLOYEE", amount: "", _isHeader: true });
  rows.push({ description: `Name: ${empName}`, amount: "" });
  if (emp?.employee_number) rows.push({ description: `Employee #: ${emp.employee_number}`, amount: "" });
  if (emp?.job_position?.name) rows.push({ description: `Position: ${emp.job_position.name}`, amount: "" });
  if (emp?.department?.name) rows.push({ description: `Department: ${emp.department.name}`, amount: "" });
  rows.push({ description: "", amount: "" });

  const earnings = lines.filter((l) => isEarning(l) && (l.employee_amount || 0) > 0);
  const deductions = lines.filter((l) => isDeduction(l) && (l.employee_amount || 0) > 0);
  const contribs = lines.filter((l) => isEmployer(l) && (l.employer_amount || 0) > 0);

  const derivedBasic = deriveBasic(lines);
  rows.push({ description: "EARNINGS", amount: "", _isHeader: true });
  if (!earnings.find((l) => l.category === "basic" || l.rule_code === "basic" || l.rule_code === "basic_salary") && derivedBasic > 0) {
    rows.push({ description: "Basic Salary", amount: derivedBasic });
  }
  for (const l of earnings) rows.push({ description: l.label || formatLabel(l.rule_code), amount: l.employee_amount });
  rows.push({ description: "Gross Pay", amount: ps.gross_pay, _isSubtotal: true });
  rows.push({ description: "", amount: "" });

  rows.push({ description: "DEDUCTIONS", amount: "", _isHeader: true });
  for (const l of deductions) rows.push({ description: l.label || formatLabel(l.rule_code), amount: l.employee_amount });
  rows.push({ description: "Total Deductions", amount: ps.total_deductions, _isSubtotal: true });

  if (contribs.length > 0) {
    rows.push({ description: "", amount: "" });
    rows.push({ description: "EMPLOYER CONTRIBUTIONS", amount: "", _isHeader: true });
    for (const l of contribs) {
      rows.push({ description: (l.label || formatLabel(l.rule_code)) + " (Employer)", amount: l.employer_amount });
    }
  }

  rows.push({ description: "", amount: "" });
  rows.push({ description: "NET PAY", amount: ps.net_pay, _isGrandTotal: true });

  const payload: ReportPdfPayload = {
    title: "Payslip",
    subtitle: run.payroll_number,
    companyName: org?.name,
    dateRange: `Pay Period: ${periodLabel}${run.payment_date ? `  |  Payment Date: ${formatDate(run.payment_date)}` : ""}`,
    organization: (org && org.id) ? (org as OrganizationBranding) : undefined,
    currency,
    orientation: "portrait",
    columns: [
      { key: "description", header: "Description", width: 65, align: "left" },
      { key: "amount", header: "Amount", width: 35, format: "currency", align: "right" },
    ],
    rows,

  };
  return await generateReportPdf(payload);
}

// ── PDF: Payroll Summary ────────────────────────────────────────────────────
async function generatePayrollSummaryPdf(
  run: PayrollRunRow, payslips: PayslipRow[], lines: PayslipLine[], org: any,
): Promise<Uint8Array> {
  const currency = org.currency || "USD";
  const byPs = linesByPayslip(lines);

  const rows: Array<Record<string, any>> = payslips.map((ps) => {
    const emp = ps.employee;
    const psLines = byPs.get(ps.id) || [];
    const earnings = psLines
      .filter((l) => isEarning(l))
      .reduce((s, l) => s + (l.employee_amount || 0), 0);
    const basic = deriveBasic(psLines);
    return {
      employee_no: emp?.employee_number || "—",
      employee: emp ? `${emp.first_name} ${emp.last_name}`.trim() : "Unknown",
      basic,
      earnings: earnings - basic,
      gross: ps.gross_pay || 0,
      deductions: ps.total_deductions || 0,
      net: ps.net_pay || 0,
    };
  });

  rows.push({
    employee_no: "",
    employee: `TOTAL (${run.employee_count} employees)`,
    basic: "",
    earnings: "",
    gross: run.total_gross || 0,
    deductions: payslips.reduce((s, p) => s + (p.total_deductions || 0), 0),
    net: run.total_net || 0,
    _isGrandTotal: true,
  });

  const payload: ReportPdfPayload = {
    title: "Payroll Summary",
    subtitle: run.payroll_number,
    companyName: org?.name,
    dateRange: `Period: ${formatDate(run.pay_period_start)} – ${formatDate(run.pay_period_end)}  |  Status: ${run.status}`,
    organization: (org && org.id) ? (org as OrganizationBranding) : undefined,
    currency,
    orientation: "landscape",
    columns: [
      { key: "employee_no", header: "Emp #", width: 10, align: "left" },
      { key: "employee", header: "Employee", width: 28, align: "left" },
      { key: "basic", header: "Basic", width: 13, format: "currency", align: "right" },
      { key: "earnings", header: "Other Earnings", width: 14, format: "currency", align: "right" },
      { key: "gross", header: "Gross", width: 13, format: "currency", align: "right" },
      { key: "deductions", header: "Deductions", width: 12, format: "currency", align: "right" },
      { key: "net", header: "Net Pay", width: 10, format: "currency", align: "right" },
    ],
    rows,
  };
  return await generateReportPdf(payload);
}

// ── CSV: Payroll Register (one row per employee × all lines pivoted) ───────
function generatePayrollRegisterCSV(
  run: PayrollRunRow, payslips: PayslipRow[], lines: PayslipLine[],
): string {
  const byPs = linesByPayslip(lines);
  const earningKeys = new Set<string>();
  const deductionKeys = new Set<string>();
  const employerKeys = new Set<string>();
  for (const l of lines) {
    if (isEarning(l)) earningKeys.add(l.rule_code);
    else if (isDeduction(l)) deductionKeys.add(l.rule_code);
    else if (isEmployer(l)) employerKeys.add(l.rule_code);
  }
  const eArr = Array.from(earningKeys);
  const dArr = Array.from(deductionKeys);
  const cArr = Array.from(employerKeys);

  const headers = [
    "Employee #", "Employee Name", "Department", "Position",
    ...eArr.map(formatLabel),
    "Gross Pay",
    ...dArr.map(formatLabel),
    "Total Deductions",
    ...cArr.map((k) => formatLabel(k) + " (ER)"),
    "Net Pay",
  ];

  const rows = payslips.map((ps) => {
    const emp = ps.employee;
    const psLines = byPs.get(ps.id) || [];
    const lookupEmp = (k: string) => psLines.find((l) => l.rule_code === k)?.employee_amount || 0;
    const lookupEr = (k: string) => psLines.find((l) => l.rule_code === k)?.employer_amount || 0;
    const row: (string | number)[] = [
      emp?.employee_number || "—",
      emp ? `${emp.first_name} ${emp.last_name}`.trim() : "Unknown",
      emp?.department?.name || "—",
      emp?.job_position?.name || "—",
    ];
    for (const k of eArr) row.push(lookupEmp(k).toFixed(2));
    row.push((ps.gross_pay || 0).toFixed(2));
    for (const k of dArr) row.push(lookupEmp(k).toFixed(2));
    row.push((ps.total_deductions || 0).toFixed(2));
    for (const k of cArr) row.push(lookupEr(k).toFixed(2));
    row.push((ps.net_pay || 0).toFixed(2));
    return row;
  });
  return toCSV(headers, rows);
}

function generatePayrollSummaryCSV(payslips: PayslipRow[], lines: PayslipLine[]): string {
  const byPs = linesByPayslip(lines);
  const headers = ["Employee #", "Name", "Basic", "Gross", "Total Deductions", "Net Pay"];
  const rows = payslips.map((ps) => {
    const emp = ps.employee;
    const psLines = byPs.get(ps.id) || [];
    return [
      emp?.employee_number || "—",
      emp ? `${emp.first_name} ${emp.last_name}`.trim() : "Unknown",
      deriveBasic(psLines).toFixed(2),
      (ps.gross_pay || 0).toFixed(2),
      (ps.total_deductions || 0).toFixed(2),
      (ps.net_pay || 0).toFixed(2),
    ];
  });
  return toCSV(headers, rows);
}

function generateBankPaymentCSV(
  payslips: PayslipRow[], run: PayrollRunRow, format: string, companyAcct?: string,
): string {
  const transfers = payslips
    .filter((ps) => ps.net_pay > 0 && ps.employee)
    .map((ps) => ({
      employeeNumber: ps.employee!.employee_number || "",
      employeeName: `${ps.employee!.first_name} ${ps.employee!.last_name}`.trim(),
      bankName: ps.employee!.bank_name || "",
      bankCode: ps.employee!.bank_code || "",
      bankBranch: ps.employee!.bank_branch || "",
      accountNumber: ps.employee!.bank_account_number || "",
      amount: ps.net_pay,
      reference: `${run.payroll_number}-${ps.employee!.employee_number || ""}`,
    }));
  if (transfers.length === 0) throw new Error("No employees with bank details and net pay > 0");

  // Generic CSV — country/bank-specific formats live in localization packs.
  const headers = ["Employee Number", "Employee Name", "Bank Name", "Bank Code", "Branch", "Account Number", "Amount", "Reference"];
  const rows = transfers.map((t) => [
    t.employeeNumber, t.employeeName, t.bankName, t.bankCode, t.bankBranch, t.accountNumber, t.amount.toFixed(2), t.reference,
  ]);
  return toCSV(headers, rows);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { global: { headers: { Authorization: authHeader || "" } } },
    );

    const body: RequestBody = await req.json();
    const { document_type, payroll_run_id, payslip_id, bank_file_format, company_account_number } = body;

    if (!payroll_run_id) throw new Error("payroll_run_id is required");

    const run = await fetchPayrollRun(supabase, payroll_run_id);

    // AUTH GATE: verify caller belongs to the payroll run's organization.
    const { requireOrgMember } = await import("../_shared/requireOrgMember.ts");
    const authResult = await requireOrgMember(req, run.organization_id, corsHeaders);
    if (!authResult.ok) return authResult.response;

    {
      const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const entResult = await checkAppEntitlement(supabase, run.organization_id, "payroll", { requireInstalled: true });
      if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);
    }

    const org = await fetchOrgDetails(supabase, run.organization_id);
    const targetPsId = document_type === "payslip" ? payslip_id : undefined;
    const payslips = await fetchPayslips(supabase, payroll_run_id, targetPsId);
    const lines = await fetchLines(supabase, payroll_run_id, targetPsId);

    switch (document_type) {
      case "payslip": {
        if (payslips.length === 0) throw new Error("Payslip not found");
        const psLines = lines.filter((l) => l.payslip_id === payslips[0].id);
        const pdfBytes = await generatePayslipPdf(payslips[0], psLines, run, org);
        return new Response(pdfBytes as unknown as BodyInit, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="Payslip_${payslips[0].employee?.employee_number || "unknown"}_${run.payroll_number}.pdf"`,
          },
        });
      }
      case "payroll_summary_pdf": {
        const pdfBytes = await generatePayrollSummaryPdf(run, payslips, lines, org);
        return new Response(pdfBytes as unknown as BodyInit, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="Payroll_Summary_${run.payroll_number}.pdf"`,
          },
        });
      }
      case "payroll_summary_excel": {
        return new Response(generatePayrollSummaryCSV(payslips, lines), {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="Payroll_Summary_${run.payroll_number}.csv"`,
          },
        });
      }
      case "payroll_register": {
        return new Response(generatePayrollRegisterCSV(run, payslips, lines), {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="Payroll_Register_${run.payroll_number}.csv"`,
          },
        });
      }
      case "bank_payment_file": {
        return new Response(generateBankPaymentCSV(payslips, run, bank_file_format || "generic_csv", company_account_number), {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="Bank_Payment_${run.payroll_number}.csv"`,
          },
        });
      }
      default:
        throw new Error(
          `Unknown or unsupported document type: ${document_type}. ` +
          `Country-specific statutory returns are handled by generate-statutory-return (template-driven).`,
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error generating payroll document:", error);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
