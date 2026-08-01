/**
 * Payslip snapshot — projection + renderer (Phase 3, ADR-0084 adoption).
 *
 * A payslip is pay-record evidence: an employee may re-download a copy
 * years later and it must reproduce exactly what they were paid at the
 * time, not what the tables happen to say today. Historically the payslip
 * PDF was produced by `generate-payslip-pdf`, which re-fetched every
 * source row (lines, YTD aggregates, statutory identifiers, org branding,
 * tenant display settings) at download time — a reprint could silently
 * change.
 *
 * This module splits that work in two:
 *
 *   buildPayslipSnapshot()      source rows -> frozen JSON snapshot
 *   renderPayslipSnapshotToPdf() frozen JSON snapshot -> PDF bytes
 *
 * The snapshot is stored on `document_records.snapshot` and the renderer
 * is a pure function of it, so every reprint of a given payslip document
 * record is byte-identical. `generate-payslip-pdf` and the AST renderer
 * for `payroll.payslip` both go through these two functions — there is
 * exactly one payslip projection and one payslip layout in the codebase.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generateReportPdf, type ReportPdfPayload } from "../reportPdfGenerator.ts";
import { assertStatutoryPaper } from "../pdf/index.ts";
import { getOrganizationBranding, type OrganizationBranding } from "../branding/index.ts";
import { adaptBracketBreakdown, formatBreakdownRowForPdf } from "../breakdownAdaptor.ts";
import { classifyPayslipLine } from "../payslipClassifier.ts";

// ── Types ───────────────────────────────────────────────────────────────

interface PayslipDetail {
  label: string;
  amount: number;
  type: "earning" | "deduction" | "contribution";
  rule_code?: string;
  source?: unknown;
  employee_amount?: number;
  employer_amount?: number;
}

/** The frozen blob written to `document_records.snapshot`. */
export interface PayslipSnapshot extends Record<string, unknown> {
  document_type: "payslip";
  snapshot_version: 1;
  payslip_id: string;
  payslip_number: string;
  period_label: string;
  payment_date: string | null;
  employee_name: string;
  employee_number: string | null;
  currency: string;
  organization: OrganizationBranding | null;
  /** Fully-resolved report payload — the layout reads nothing else. */
  report: {
    title: string;
    subtitle: string;
    dateRange: string;
    columns: ReportPdfPayload["columns"];
    rows: ReportPdfPayload["rows"];
  };
  filename_stem: string;
}

export interface BuiltPayslipSnapshot {
  snapshot: PayslipSnapshot;
  documentNumber: string;
  /** ISO date (YYYY-MM-DD) of the pay period end / payment date. */
  documentDate: string | null;
  organizationId: string | null;
  businessId: string | null;
  branchId: string | null;
  employeeId: string | null;
  currency: string;
  filename: string;
}

export class PayslipNotFoundError extends Error {
  constructor(detail?: string) {
    super(detail ? `payslip_not_found: ${detail}` : "payslip_not_found");
    this.name = "PayslipNotFoundError";
  }
}

export interface BuildPayslipSnapshotArgs {
  payslipId?: string | null;
  payrollRunId?: string | null;
  employeeId?: string | null;
}

// ── Projection ──────────────────────────────────────────────────────────

/**
 * Read every source row a payslip depends on and freeze it into a
 * self-contained snapshot. Deterministic: no wall-clock values are
 * introduced, so re-running it on unchanged source data yields an
 * identical blob (which keeps `ensure_document_record` idempotent).
 */
export async function buildPayslipSnapshot(
  supabase: SupabaseClient,
  args: BuildPayslipSnapshotArgs,
): Promise<BuiltPayslipSnapshot> {
  if (!args.payslipId && !(args.payrollRunId && args.employeeId)) {
    throw new Error("buildPayslipSnapshot: payslip_id or payroll_run_id + employee_id required");
  }

  let query = supabase
    .from("payslips")
    .select(`
      *,
      employee:employees(
        id, first_name, last_name, employee_number, email,
        department:departments!employees_department_id_fkey(name), job_position:job_positions(name),
        bank_name, bank_account_number, bank_branch,
        national_id,
        organization_id
      ),
      payroll_run:payroll_runs(
        id, payroll_number, pay_period_start, pay_period_end, payment_date, status,
        business_id, branch_id
      )
    `);

  if (args.payslipId) {
    query = query.eq("id", args.payslipId);
  } else {
    query = query.eq("payroll_run_id", args.payrollRunId!).eq("employee_id", args.employeeId!);
  }

  const { data: payslip, error: psError } = await query.single();
  if (psError || !payslip) throw new PayslipNotFoundError(psError?.message);

  const emp = (payslip as Record<string, any>).employee;
  const run = (payslip as Record<string, any>).payroll_run;

  // ── Branding + tenant display settings ────────────────────────────
  let organization: OrganizationBranding | null = null;
  let currency = "USD";
  let showExplainer = true;
  // Default OFF, Odoo-aligned: the generic payslip prints employer name only.
  let showEmployerStatutoryIds = false;
  if (emp?.organization_id) {
    organization = await getOrganizationBranding(supabase, emp.organization_id);
    if (organization?.base_currency) currency = organization.base_currency;
    const { data: ps } = await supabase
      .from("payroll_settings")
      .select("pdf_show_explainer, payslip_show_employer_statutory_ids")
      .eq("organization_id", emp.organization_id)
      .maybeSingle();
    if (ps && typeof (ps as any).pdf_show_explainer === "boolean") {
      showExplainer = (ps as any).pdf_show_explainer;
    }
    if (ps && typeof (ps as any).payslip_show_employer_statutory_ids === "boolean") {
      showEmployerStatutoryIds = (ps as any).payslip_show_employer_statutory_ids;
    }
  }

  // ── Sections: payslip_lines is authoritative ────────────────────────
  // The payroll engine is the only producer of pay lines. This projection
  // never synthesises, back-fills or re-derives an earning (a synthetic
  // "Basic Salary" row here was the historic duplicate-line regression) —
  // it buckets what the engine wrote and nothing else.

  const earnings: PayslipDetail[] = [];
  const deductions: PayslipDetail[] = [];
  const contributions: PayslipDetail[] = [];

  const { data: lineRows, error: linesErr } = await supabase
    .from("payslip_lines")
    .select("rule_code, label, category, employee_amount, employer_amount, sequence, source")
    .eq("payslip_id", payslip.id)
    .order("sequence", { ascending: true });
  if (linesErr) throw new Error(`payslip_lines_unavailable: ${linesErr.message}`);

  // Bucket each line via the single shared classifier — never reinvent
  // the categorisation logic in the renderer. See payslipClassifier.ts.
  for (const l of (lineRows || []) as any[]) {
    const empAmt = Number(l.employee_amount || 0);
    const erAmt = Number(l.employer_amount || 0);
    const label = l.label || formatLabel(l.rule_code || "");
    const code = (l.rule_code || "").toString();
    const bucket = classifyPayslipLine(l);
    if (bucket === "earning" && empAmt !== 0) {
      earnings.push({ label, amount: empAmt, type: "earning", rule_code: code, source: l.source });
    } else if (bucket === "deduction" && empAmt !== 0) {
      deductions.push({
        label, amount: empAmt, type: "deduction", rule_code: code, source: l.source,
        employee_amount: empAmt, employer_amount: erAmt,
      });
    } else if (bucket === "employer_contribution" && erAmt !== 0) {
      contributions.push({
        label, amount: erAmt, type: "contribution", rule_code: code, source: l.source,
        employee_amount: empAmt, employer_amount: erAmt,
      });
    }
  }

  // ── Proration footnote + per-earning breakdown ──
  let prorationNote: string | null = null;
  let prorationFactor = 1;
  let contractBaselines: Record<string, number> = {};
  {
    const { data: prorationRow } = await supabase
      .from("payslip_inputs")
      .select("quantity, metadata")
      .eq("payslip_id", payslip.id)
      .eq("source", "contract")
      .eq("label", "Proration factor")
      .maybeSingle();
    if (prorationRow && Number((prorationRow as any).quantity) < 1) {
      prorationFactor = Number((prorationRow as any).quantity);
      const md = ((prorationRow as any).metadata || {}) as {
        hire_date?: string;
        termination_date?: string;
        contract_basic?: number;
        contract_housing?: number;
        contract_transport?: number;
        contract_other?: Record<string, number>;
      };
      const reason = md.hire_date
        ? `Hired ${formatDate(md.hire_date)}`
        : md.termination_date
        ? `Terminated ${formatDate(md.termination_date)}`
        : "Partial period";
      prorationNote = `Earnings prorated × ${prorationFactor.toFixed(4)} (${reason}).`;
      contractBaselines = {
        basic: Number(md.contract_basic ?? 0),
        housing_allowance: Number(md.contract_housing ?? 0),
        transport_allowance: Number(md.contract_transport ?? 0),
        ...(md.contract_other || {}),
      };
    }
  }

  // ── Shared, country-agnostic payslip header ──
  const { data: headerData, error: headerErr } = await supabase.rpc("payslip_header", {
    _payslip_id: payslip.id,
  });
  const headerHasError = !!headerErr || !!(headerData as any)?.error;
  const header: any = headerData && !headerHasError ? headerData : null;

  // `payslip_header` is the ONLY source of statutory identifiers on this
  // projection. The former direct reads of employee_/organization_
  // statutory_identifiers were a second, unshaped source of truth: they
  // bypassed the RPC's relevance filtering and pack labelling, so the PDF
  // could show identifiers the UI hid. If the RPC returns no identifiers,
  // the payslip legitimately has none.


  // Pack-declared label registry — keyed by identifier_type.
  const labelByType: Record<string, string> = {};
  for (const r of (header?.pack?.required || []) as Array<{ identifier_type: string; label?: string }>) {
    if (r?.identifier_type && r?.label) labelByType[r.identifier_type] = r.label;
  }
  const idLabel = (t: string): string => labelByType[t] || humaniseId(t);

  // ── Rows ──
  const empName = header?.employee?.name
    || (emp ? `${emp.first_name} ${emp.last_name}` : "Employee");
  const payslipNumber = run?.payroll_number && emp?.employee_number
    ? `${run.payroll_number} / ${emp.employee_number}`
    : (run?.payroll_number || "—");
  const periodLabel = run
    ? `${formatDate(run.pay_period_start)} – ${formatDate(run.pay_period_end)}`
    : "—";

  const rows: Array<Record<string, any>> = [];

  // Header diagnostics — render only on hard RPC failure. Missing required
  // identifiers are admin-only notes, never employee-facing (ADR-0036 §I9).
  if (headerHasError) {
    rows.push({
      description: `[ERROR] Statutory header could not be resolved (${headerErr?.message || (headerData as any)?.error}). Contact your administrator.`,
      amount: "",
    });
    rows.push({ description: "", amount: "" });
  }

  type HeaderId = { identifier_type: string; identifier_value: string; relevance?: string };
  const filterConsumed = (ids: HeaderId[]): HeaderId[] =>
    ids.some((x) => x.relevance) ? ids.filter((x) => x.relevance === "consumed") : ids;
  const hasValue = (x: HeaderId) =>
    typeof x.identifier_value === "string" && x.identifier_value.trim() !== "";

  rows.push({ description: "Employer", amount: "", _isHeader: true });
  rows.push({ description: header?.employer?.name || organization?.name || "—", amount: "" });
  if (showEmployerStatutoryIds) {
    const employerIds = filterConsumed((header?.employer?.statutory_ids || []) as HeaderId[]).filter(hasValue);
    for (let i = 0; i < employerIds.length; i += 2) {
      const a = employerIds[i];
      const b = employerIds[i + 1];
      const left = `${idLabel(a.identifier_type)}: ${a.identifier_value}`;
      const right = b ? `   |   ${idLabel(b.identifier_type)}: ${b.identifier_value}` : "";
      rows.push({ description: left + right, amount: "" });
    }
  }
  rows.push({ description: "", amount: "" });

  rows.push({ description: `Payslip #: ${payslipNumber}`, amount: "" });

  rows.push({ description: "Employee", amount: "", _isHeader: true });
  rows.push({ description: `Name: ${empName}`, amount: "" });
  const empNumber = header?.employee?.employee_number ?? emp?.employee_number;
  if (empNumber) rows.push({ description: `Employee #: ${empNumber}`, amount: "" });
  const empPosition = header?.employee?.position ?? emp?.job_position?.name ?? null;
  const empDepartment = header?.employee?.department ?? emp?.department?.name ?? null;
  if (empPosition) rows.push({ description: `Position: ${empPosition}`, amount: "" });
  if (empDepartment) rows.push({ description: `Department: ${empDepartment}`, amount: "" });
  const bankName = header?.employee?.bank_name ?? emp?.bank_name;
  const bankBranch = header?.employee?.bank_branch ?? emp?.bank_branch;
  const bankAcct = header?.employee?.bank_account_masked
    ?? (emp?.bank_account_number ? maskAccount(emp.bank_account_number) : null);
  if (bankName) rows.push({ description: `Bank: ${bankName}${bankBranch ? ` (${bankBranch})` : ""}`, amount: "" });
  if (bankAcct) rows.push({ description: `Account: ${bankAcct}`, amount: "" });

  const empIds = filterConsumed((header?.employee?.statutory_ids || []) as HeaderId[]).filter(hasValue);
  for (let i = 0; i < empIds.length; i += 2) {
    const a = empIds[i];
    const b = empIds[i + 1];
    const left = `${idLabel(a.identifier_type)}: ${a.identifier_value}`;
    const right = b ? `   |   ${idLabel(b.identifier_type)}: ${b.identifier_value}` : "";
    rows.push({ description: left + right, amount: "" });
  }

  rows.push({ description: "", amount: "" });

  // Earnings — when proration applies, show "contract × factor = amount"
  rows.push({ description: "EARNINGS", amount: "", _isHeader: true });
  for (const e of earnings) {
    rows.push({ description: e.label, amount: e.amount });
    if (prorationFactor < 1 && e.rule_code) {
      const baseline = contractBaselines[e.rule_code];
      if (baseline && baseline > 0 && Math.abs(baseline - e.amount) > 0.01) {
        rows.push({
          description: `   contract ${baseline.toFixed(2)} × ${prorationFactor.toFixed(4)} = ${e.amount.toFixed(2)}`,
          amount: "",
          _isSubnote: true,
        });
      }
    }
  }
  if (prorationNote) rows.push({ description: prorationNote, amount: "" });
  rows.push({ description: "Gross Pay", amount: payslip.gross_pay, _isSubtotal: true });

  rows.push({ description: "", amount: "" });

  rows.push({ description: "DEDUCTIONS", amount: "", _isHeader: true });
  for (const d of deductions) {
    rows.push({ description: d.label, amount: d.amount });
    if (showExplainer) {
      const v = adaptBracketBreakdown({
        label: d.label,
        rule_code: d.rule_code,
        employee_amount: d.employee_amount,
        employer_amount: d.employer_amount,
        source: d.source,
      });
      for (const line of v.explanation) {
        rows.push({ description: `   ${line}`, amount: "", _isSubnote: true });
      }
      for (const r of v.employeeRows) {
        rows.push({ description: formatBreakdownRowForPdf(r, currency), amount: "", _isSubnote: true });
      }
    }
  }
  rows.push({ description: "Total Deductions", amount: payslip.total_deductions, _isSubtotal: true });

  if (contributions.length > 0) {
    rows.push({ description: "", amount: "" });
    rows.push({ description: "EMPLOYER CONTRIBUTIONS", amount: "", _isHeader: true });
    for (const c of contributions) {
      rows.push({ description: c.label, amount: c.amount });
      if (showExplainer) {
        const v = adaptBracketBreakdown({
          label: c.label,
          rule_code: c.rule_code,
          employee_amount: c.employee_amount,
          employer_amount: c.employer_amount,
          source: c.source,
        });
        for (const r of v.employerRows) {
          rows.push({ description: formatBreakdownRowForPdf(r, currency), amount: "", _isSubnote: true });
        }
      }
    }
    const totalContributions = contributions.reduce((s, c) => s + c.amount, 0);
    rows.push({ description: "Total Employer Contributions", amount: totalContributions, _isSubtotal: true });
  }

  rows.push({ description: "", amount: "" });
  rows.push({ description: "NET PAY", amount: payslip.net_pay, _isGrandTotal: true });

  // ── Year-to-date section (ADR-0036 §I9) ──
  if (emp?.id && run?.pay_period_end) {
    const fy = new Date(run.pay_period_end).getUTCFullYear();
    const { data: ytdRows, error: ytdErr } = await supabase
      .from("payroll_employee_ytd")
      .select("rule_code, category, employee_amount, employer_amount, taxable_amount, payslip_count")
      .eq("employee_id", emp.id)
      .eq("fiscal_year", fy);
    if (ytdErr) {
      console.warn("[payslipSnapshot] YTD fetch failed", ytdErr.message);
    } else if (ytdRows && ytdRows.length > 0) {
      rows.push({ description: "", amount: "" });
      rows.push({ description: `YEAR-TO-DATE (FY ${fy})`, amount: "", _isHeader: true });

      let ytdGross = 0;
      let ytdEmployeeDed = 0;
      let ytdEmployerCon = 0;
      for (const y of ytdRows as any[]) {
        const bucket = classifyPayslipLine(y);
        const emp$ = Number(y.employee_amount || 0);
        const er$ = Number(y.employer_amount || 0);
        if (bucket === "earning") {
          ytdGross += emp$;
        } else {
          // Sum each column independently: employee withholdings and the
          // employer contributions they trigger are borne by different
          // parties and cannot share a column.
          ytdEmployeeDed += emp$;
          ytdEmployerCon += er$;
        }
      }
      rows.push({ description: "YTD Gross Earnings", amount: ytdGross });
      rows.push({ description: "YTD Employee Deductions", amount: ytdEmployeeDed });
      if (ytdEmployerCon > 0) {
        rows.push({ description: "YTD Employer Contributions (paid by employer)", amount: ytdEmployerCon });
      }
      rows.push({ description: "YTD Net Pay", amount: ytdGross - ytdEmployeeDed, _isSubtotal: true });

      // Per-rule YTD breakdown is intentionally omitted from the
      // employee-facing payslip; it belongs to the tax certificate /
      // annual statutory report surface.
    }
  }

  const filename = `Payslip_${empName.replace(/\s+/g, "_")}_${run?.payroll_number || ""}`
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  const snapshot: PayslipSnapshot = {
    document_type: "payslip",
    snapshot_version: 1,
    payslip_id: payslip.id,
    payslip_number: payslipNumber,
    period_label: periodLabel,
    payment_date: run?.payment_date ?? null,
    employee_name: empName,
    employee_number: empNumber ?? null,
    currency,
    organization: organization ?? null,
    report: {
      title: "Payslip",
      subtitle: `Payslip #${payslipNumber}`,
      dateRange: `Pay Period: ${periodLabel}${run?.payment_date ? `  |  Payment Date: ${formatDate(run.payment_date)}` : ""}`,
      columns: [
        { key: "description", header: "Description", width: 65, align: "left" },
        { key: "amount", header: "Amount", width: 35, format: "currency", align: "right" },
      ],
      rows,
    },
    filename_stem: filename,
  };

  return {
    snapshot,
    documentNumber: payslipNumber,
    documentDate: isoDate(run?.pay_period_end ?? run?.payment_date ?? null),
    organizationId: emp?.organization_id ?? null,
    businessId: run?.business_id ?? (payslip as any).business_id ?? null,
    branchId: run?.branch_id ?? (payslip as any).branch_id ?? null,
    employeeId: emp?.id ?? (payslip as any).employee_id ?? null,
    currency,
    filename,
  };
}

// ── Layout ──────────────────────────────────────────────────────────────

/**
 * Pure snapshot -> PDF. Reads nothing but the snapshot, which is what
 * makes a reprint byte-identical to the original issue.
 */
export async function renderPayslipSnapshotToPdf(
  snapshot: PayslipSnapshot | Record<string, unknown>,
): Promise<Uint8Array> {
  const snap = snapshot as PayslipSnapshot;
  const report = snap.report;
  if (!report || !Array.isArray(report.rows)) {
    throw new Error("payslip_snapshot_invalid: missing report.rows");
  }

  const payload: ReportPdfPayload = {
    title: report.title ?? "Payslip",
    subtitle: report.subtitle,
    companyName: snap.organization?.name,
    dateRange: report.dateRange,
    organization: snap.organization ?? undefined,
    currency: snap.currency ?? "USD",
    orientation: "portrait",
    columns: report.columns,
    rows: report.rows,
  };

  // STATUTORY PAPER PIN — payslips are pay-record evidence required at A4
  // across the jurisdictions we support.
  assertStatutoryPaper("a4");
  return await generateReportPdf(payload);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function maskAccount(account: string): string {
  if (account.length <= 4) return account;
  return "****" + account.slice(-4);
}

// Country-agnostic humaniser for statutory identifier_type codes.
//
// This is the LAST resort only: a localization pack that declares the
// identifier ships its own display label via `pack_requirements.label`,
// and that always wins (see `idLabel` above). Because no jurisdiction may
// be named here, abbreviation detection is structural rather than a list
// of known agency acronyms: a short token that is not an ordinary English
// connector word is treated as an initialism and upper-cased.
const GENERIC_WORDS = new Set([
  "tax", "id", "no", "num", "code", "ref", "type", "card", "reg", "of", "and",
]);
function humaniseId(code: string): string {
  return String(code || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((p) => {
      const lower = p.toLowerCase();
      const isInitialism = lower.length <= 5 && !GENERIC_WORDS.has(lower);
      return isInitialism
        ? p.toUpperCase()
        : p.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

