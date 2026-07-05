/**
 * Generate Payslip PDF Edge Function
 * 
 * Produces a professional, branded payslip PDF for a single employee.
 * Uses the shared reportPdfGenerator engine for consistent branding.
 * 
 * Accepts: { payslip_id } or { payroll_run_id, employee_id }
 * Returns: application/pdf binary
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generateReportPdf, type ReportPdfPayload } from "../_shared/reportPdfGenerator.ts";
import { assertStatutoryPaper } from "../_shared/pdf/index.ts";
import { getOrganizationBranding, type OrganizationBranding } from "../_shared/branding/index.ts";
import { adaptBracketBreakdown, formatBreakdownRowForPdf } from "../_shared/breakdownAdaptor.ts";
import { classifyPayslipLine } from "../_shared/payslipClassifier.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface PayslipDetail {
  label: string;
  amount: number;
  type: "earning" | "deduction" | "contribution";
  rule_code?: string;
  source?: any;
  employee_amount?: number;
  employer_amount?: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { payslip_id, payroll_run_id, employee_id } = body;

    if (!payslip_id && !(payroll_run_id && employee_id)) {
      return new Response(
        JSON.stringify({ error: "Provide payslip_id or payroll_run_id + employee_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch payslip — only select columns that actually exist in the schema
    // Wave 1.1: position/department resolved via FK joins (legacy text cols dropped)
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
          id, payroll_number, pay_period_start, pay_period_end, payment_date, status
        )
      `);

    if (payslip_id) {
      query = query.eq("id", payslip_id);
    } else {
      query = query.eq("payroll_run_id", payroll_run_id).eq("employee_id", employee_id);
    }

    const { data: payslip, error: psError } = await query.single();
    if (psError || !payslip) {
      console.error("Payslip query error:", psError);
      return new Response(
        JSON.stringify({ error: "Payslip not found", detail: psError?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emp = payslip.employee;
    const run = payslip.payroll_run;

    // ─── Subscription entitlement check ───
    if (emp?.organization_id) {
      const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const entResult = await checkAppEntitlement(supabase, emp.organization_id, "payroll", { requireInstalled: true });
      if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);
    }

    // ─── Module permission check (payroll.read) ───
    // Require auth unconditionally. Allow self-service for the employee.
    if (emp?.organization_id) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: "unauthorized: missing authorization header" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const token = authHeader.replace("Bearer ", "");
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      const userId = userData?.user?.id;
      if (userErr || !userId) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Check if this user IS the employee (self-service)
      const { data: selfRow } = await supabase
        .from("employees")
        .select("user_id")
        .eq("id", emp.id)
        .maybeSingle();
      const isSelf = selfRow?.user_id === userId;
      if (!isSelf) {
        const { requireModulePermission } = await import("../_shared/permissionCheck.ts");
        const denied = await requireModulePermission(
          supabase, userId, emp.organization_id, "payroll", "read", corsHeaders,
        );
        if (denied) return denied;
      }
    }

    // Fetch organization branding via the centralized loader (single canonical
    // source — guarantees logo + address + tax id are present and consistent).
    let organization: OrganizationBranding | null = null;
    let currency = "USD";
    let showExplainer = true;
    // Default OFF, Odoo-aligned: the generic payslip prints employer name only.
    // The tenant flips this on in /hr/payroll/setup if they want their KRA PIN /
    // NSSF / SHIF / AHL numbers printed on every payslip.
    let showEmployerStatutoryIds = false;
    if (emp?.organization_id) {
      organization = await getOrganizationBranding(supabase, emp.organization_id);
      if (organization?.base_currency) currency = organization.base_currency;
      const { data: ps } = await supabase
        .from("payroll_settings")
        .select("pdf_show_explainer, payslip_show_employer_statutory_ids")
        .eq("organization_id", emp.organization_id)
        .maybeSingle();
      if (ps && typeof ps.pdf_show_explainer === "boolean") {
        showExplainer = ps.pdf_show_explainer;
      }
      if (ps && typeof (ps as any).payslip_show_employer_statutory_ids === "boolean") {
        showEmployerStatutoryIds = (ps as any).payslip_show_employer_statutory_ids;
      }
    }

    // ── Build sections from payslip_lines (authoritative, country-agnostic) ──
    const earnings: PayslipDetail[] = [];
    const deductions: PayslipDetail[] = [];
    const contributions: PayslipDetail[] = [];

    const { data: lineRows, error: linesErr } = await supabase
      .from("payslip_lines")
      .select("rule_code, label, category, employee_amount, employer_amount, sequence, source")
      .eq("payslip_id", payslip.id)
      .order("sequence", { ascending: true });
    if (linesErr) {
      return new Response(
        JSON.stringify({ error: "Could not load payslip_lines", detail: linesErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
        deductions.push({ label, amount: empAmt, type: "deduction", rule_code: code, source: l.source, employee_amount: empAmt, employer_amount: erAmt });
      } else if (bucket === "employer_contribution" && erAmt !== 0) {
        contributions.push({ label, amount: erAmt, type: "contribution", rule_code: code, source: l.source, employee_amount: empAmt, employer_amount: erAmt });
      }
    }

    // ── Proration footnote + per-earning breakdown ──
    // The compute-payroll engine writes a `payslip_inputs` row with
    // source='contract', label='Proration factor', quantity=<factor>,
    // and metadata.contract_basic / contract_housing / contract_transport /
    // contract_other carrying the un-prorated baselines, when factor < 1.
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
      if (prorationRow && Number(prorationRow.quantity) < 1) {
        prorationFactor = Number(prorationRow.quantity);
        const md = (prorationRow.metadata || {}) as {
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

    // ── Load the shared, country-agnostic payslip header ──
    // Single source of truth for employer + employee + statutory ID blocks.
    // Country-specific identifiers come from `employee_statutory_identifiers`
    // / `organization_statutory_identifiers` / `pack_requirements`. NEVER
    // hardcode an identifier_type in this file.
    const { data: headerData, error: headerErr } = await supabase.rpc("payslip_header", {
      _payslip_id: payslip.id,
    });
    const headerHasError = !!headerErr || !!(headerData as any)?.error;
    const header: any = headerData && !headerHasError ? headerData : null;
    console.info(
      "[generate-payslip-pdf] payslip_header resolved",
      JSON.stringify({
        payslip_id: payslip.id,
        rpc_error: headerErr?.message || (headerData as any)?.error || null,
        employer_country: header?.employer?.country_code ?? null,
        employer_ids: (header?.employer?.statutory_ids || []).length,
        employee_country: header?.employee?.country_code ?? null,
        employee_ids: (header?.employee?.statutory_ids || []).length,
        required: (header?.pack?.required || []).length,
        raw_shape: headerData ? Object.keys(headerData as object).slice(0, 10) : null,
        raw_emp_ids_sample: JSON.stringify(((headerData as any)?.employee?.statutory_ids || []).slice(0, 2)),
      }),
    );

    // Defensive fallback — if the RPC returned an empty identifier list
    // (older payslip_header build, JSONB unwrapping quirk, etc.) read the
    // identifier tables directly with the service-role client so the
    // payslip never falsely reports a missing required ID.
    if (header && (header.employee?.statutory_ids?.length ?? 0) === 0 && emp?.id) {
      const { data: empIdsDirect } = await supabase
        .from("employee_statutory_identifiers")
        .select("identifier_type, identifier_value, country_code")
        .eq("employee_id", emp.id)
        .eq("is_active", true)
        .not("identifier_value", "is", null);
      if (empIdsDirect && empIdsDirect.length > 0) {
        header.employee.statutory_ids = empIdsDirect.filter((r: any) => (r.identifier_value || "").trim() !== "");
        console.info("[generate-payslip-pdf] fallback employee_statutory_identifiers", empIdsDirect.length);
      }
    }
    if (header && (header.employer?.statutory_ids?.length ?? 0) === 0 && emp?.organization_id) {
      const { data: orgIdsDirect } = await supabase
        .from("organization_statutory_identifiers")
        .select("identifier_type, identifier_value, country_code, business_id")
        .eq("organization_id", emp.organization_id)
        .eq("is_active", true)
        .not("identifier_value", "is", null);
      if (orgIdsDirect && orgIdsDirect.length > 0) {
        header.employer.statutory_ids = orgIdsDirect.filter((r: any) => (r.identifier_value || "").trim() !== "");
        console.info("[generate-payslip-pdf] fallback organization_statutory_identifiers", orgIdsDirect.length);
      }
    }

    // Pack-declared label registry — keyed by identifier_type. Falls back
    // to the country-agnostic humaniser when a pack doesn't ship a label.
    const labelByType: Record<string, string> = {};
    for (const r of (header?.pack?.required || []) as Array<{ identifier_type: string; label?: string }>) {
      if (r?.identifier_type && r?.label) labelByType[r.identifier_type] = r.label;
    }
    const idLabel = (t: string): string => labelByType[t] || humaniseId(t);


    // ── Build PDF rows ──
    const empName = header?.employee?.name
      || (emp ? `${emp.first_name} ${emp.last_name}` : "Employee");
    const payslipNumber = run?.payroll_number && emp?.employee_number
      ? `${run.payroll_number} / ${emp.employee_number}`
      : (run?.payroll_number || "—");
    const periodLabel = run
      ? `${formatDate(run.pay_period_start)} – ${formatDate(run.pay_period_end)}`
      : "—";

    const rows: Array<Record<string, any>> = [];

    // Header diagnostics — render only on hard RPC failure. Missing
    // required identifiers DO NOT belong on an employee-facing legal
    // document; they are admin-only notes surfaced through `header.notes`
    // and a pre-finalize gate. See ADR-0036 §I9 (Payslip Surface Contract).
    if (headerHasError) {
      rows.push({
        description: `[ERROR] Statutory header could not be resolved (${headerErr?.message || (headerData as any)?.error}). Contact your administrator.`,
        amount: "",
      });
      rows.push({ description: "", amount: "" });
    }

    type HeaderId = { identifier_type: string; identifier_value: string; relevance?: string };
    const filterConsumed = (ids: HeaderId[]): HeaderId[] =>
      // Backwards-compat: older `payslip_header` builds didn't emit
      // `relevance`. Fall back to showing every ID so we never blank
      // the employer block on a stale RPC.
      ids.some((x) => x.relevance) ? ids.filter((x) => x.relevance === "consumed") : ids;

    // Drop any identifier whose value is null/empty/whitespace. A blank
    // value MUST never render as "MISSING" or as an empty " : " row on an
    // employee-facing legal document — Odoo silently omits and so do we.
    const hasValue = (x: HeaderId) =>
      typeof x.identifier_value === "string" && x.identifier_value.trim() !== "";

    // Employer block — only registrations actually consumed by a rule
    // that produced a line on this payslip. ADP / Workday / Odoo
    // convention: the legal employer name + (optionally) the tax
    // registration that justifies the withholdings shown below.
    // Whether the IDs appear is a tenant preference (default OFF, Odoo-aligned).
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

    // Payslip metadata
    rows.push({ description: `Payslip #: ${payslipNumber}`, amount: "" });

    // Employee block
    rows.push({ description: "Employee", amount: "", _isHeader: true });
    rows.push({ description: `Name: ${empName}`, amount: "" });
    const empNumber = header?.employee?.employee_number ?? emp?.employee_number;
    if (empNumber) rows.push({ description: `Employee #: ${empNumber}`, amount: "" });
    const empPosition = header?.employee?.position ?? (emp as any)?.job_position?.name ?? null;
    const empDepartment = header?.employee?.department ?? (emp as any)?.department?.name ?? null;
    if (empPosition) rows.push({ description: `Position: ${empPosition}`, amount: "" });
    if (empDepartment) rows.push({ description: `Department: ${empDepartment}`, amount: "" });
    const bankName = header?.employee?.bank_name ?? emp?.bank_name;
    const bankBranch = header?.employee?.bank_branch ?? emp?.bank_branch;
    const bankAcct = header?.employee?.bank_account_masked
      ?? (emp?.bank_account_number ? maskAccount(emp.bank_account_number) : null);
    if (bankName) rows.push({ description: `Bank: ${bankName}${bankBranch ? ` (${bankBranch})` : ""}`, amount: "" });
    if (bankAcct) rows.push({ description: `Account: ${bankAcct}`, amount: "" });

    // Employee statutory identifiers — only those tied to a rule that
    // ran this period AND that have a non-blank value. An employee with
    // no NSSF deduction this month shouldn't see their NSSF number; an
    // employee without a registered SHIF number shouldn't see a "MISSING"
    // line either — we just omit the row.
    const empIds = filterConsumed((header?.employee?.statutory_ids || []) as HeaderId[]).filter(hasValue);
    for (let i = 0; i < empIds.length; i += 2) {
      const a = empIds[i];
      const b = empIds[i + 1];
      const left = `${idLabel(a.identifier_type)}: ${a.identifier_value}`;
      const right = b ? `   |   ${idLabel(b.identifier_type)}: ${b.identifier_value}` : "";
      rows.push({ description: left + right, amount: "" });
    }

    rows.push({ description: "", amount: "" });


    // Earnings section — when proration applies, show "contract × factor = amount"
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
    if (prorationNote) {
      rows.push({ description: prorationNote, amount: "" });
    }
    rows.push({ description: "Gross Pay", amount: payslip.gross_pay, _isSubtotal: true });

    rows.push({ description: "", amount: "" });

    // Deductions section
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
        // Taxable-base build-up / legal basis lines first, so they read as
        // a preamble to the bracket rows.
        for (const line of v.explanation) {
          rows.push({ description: `   ${line}`, amount: "", _isSubnote: true });
        }
        for (const r of v.employeeRows) {
          rows.push({ description: formatBreakdownRowForPdf(r, currency), amount: "", _isSubnote: true });
        }
      }
    }
    rows.push({ description: "Total Deductions", amount: payslip.total_deductions, _isSubtotal: true });

    // Employer contributions (if any)
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

    // Grand total
    rows.push({ description: "", amount: "" });
    rows.push({ description: "NET PAY", amount: payslip.net_pay, _isGrandTotal: true });

    // ── Year-to-date section (KRA P9 / Sage / ADP equivalent) ──
    // Aggregated from `payroll_employee_ytd` for the run's fiscal year.
    // Pure read — no compute. Country-agnostic: just lists rule_code totals.
    //
    // Critical invariants (ADR-0036 §I9):
    //   - Use the rule-label registry, NEVER the identifier-label registry,
    //     to label rule_code rows. Identifiers ≠ rules.
    //   - Never sum `employee_amount + employer_amount`. Employee
    //     withholdings and the employer contributions they trigger are
    //     borne by different parties and cannot share a column.
    if (emp?.id && run?.pay_period_end) {
      const fy = new Date(run.pay_period_end).getUTCFullYear();
      const { data: ytdRows, error: ytdErr } = await supabase
        .from("payroll_employee_ytd")
        .select("rule_code, category, employee_amount, employer_amount, taxable_amount, payslip_count")
        .eq("employee_id", emp.id)
        .eq("fiscal_year", fy);
      if (ytdErr) {
        console.warn("[generate-payslip-pdf] YTD fetch failed", ytdErr.message);
      } else if (ytdRows && ytdRows.length > 0) {
        // Build a rule-label registry from the active rule catalogs. Falls
        // back to a humanised rule_code only when no rule row is found.
        const ytdCodes = Array.from(new Set((ytdRows as any[]).map((r) => r.rule_code).filter(Boolean)));
        const ruleLabelByCode: Record<string, string> = {};
        if (ytdCodes.length > 0) {
          const [{ data: statRules }, { data: salRules }] = await Promise.all([
            supabase
              .from("payroll_statutory_rules")
              .select("rule_code, rule_name")
              .in("rule_code", ytdCodes)
              .eq("is_active", true)
              .is("superseded_by", null),
            supabase
              .from("payroll_salary_rules")
              .select("rule_code, name")
              .in("rule_code", ytdCodes),
          ]);
          for (const r of (statRules || []) as any[]) {
            if (r.rule_code && r.rule_name) ruleLabelByCode[r.rule_code] = r.rule_name;
          }
          for (const r of (salRules || []) as any[]) {
            if (r.rule_code && r.name && !ruleLabelByCode[r.rule_code]) {
              ruleLabelByCode[r.rule_code] = r.name;
            }
          }
        }
        const ruleLabel = (code: string) => ruleLabelByCode[code] || formatLabel(code);

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
            // Statutory rules with both employee + employer sides (NSSF, AHL)
            // historically collapse into a single payroll_employee_ytd row
            // with category=statutory_employer. The bucket would then drop
            // the employee amount. Sum each column independently — by column
            // definition, employee_amount is employee-paid and employer_amount
            // is employer-paid regardless of the row's category label.
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

        // NOTE: Per-rule YTD breakdown is intentionally OMITTED from the
        // employee-facing payslip PDF. Enterprise payroll convention
        // (Odoo, Sage, ADP, Workday) keeps the payslip focused on the
        // current period plus a compact YTD summary. Per-rule YTD
        // reconciliation belongs to the tax certificate / annual
        // statutory report surface, which still reads the same
        // `payroll_employee_ytd` table. `ruleLabel` is retained above
        // because the rule-label registry is still built for future
        // use by admin/audit views consuming this codepath.
        void ruleLabel;
      }
    }



    const payload: ReportPdfPayload = {
      title: "Payslip",
      subtitle: `Payslip #${payslipNumber}`,

      companyName: organization?.name,
      dateRange: `Pay Period: ${periodLabel}${run?.payment_date ? `  |  Payment Date: ${formatDate(run.payment_date)}` : ""}`,
      organization: organization ?? undefined,
      currency,
      orientation: "portrait",
      columns: [
        { key: "description", header: "Description", width: 65, align: "left" },
        { key: "amount", header: "Amount", width: 35, format: "currency", align: "right" },
      ],
      rows,
    };

    // STATUTORY PAPER PIN — payslips are pay-record evidence required by
    // labour / tax authorities at A4 across the jurisdictions we support.
    // Country-specific regulator names live in the active localization
    // pack, not here. The few markets that accept thermal payslips are
    // not enforced; loosen with care after a regulator review.
    assertStatutoryPaper("a4");
    const pdfBytes = await generateReportPdf(payload);

    const filename = `Payslip_${empName.replace(/\s+/g, "_")}_${run?.payroll_number || ""}`.replace(/[^a-zA-Z0-9_-]/g, "_");

    return new Response(pdfBytes as unknown as BodyInit, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}.pdf"`,
      },
    });
  } catch (error) {
    console.error("Payslip PDF generation error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Helpers ──

function formatLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function maskAccount(account: string): string {
  if (account.length <= 4) return account;
  return "****" + account.slice(-4);
}

// Country-agnostic humaniser for statutory identifier_type codes. NEVER
// add a country switch here; pretty labels belong in the localization
// pack / pack_requirements.label column.
const ID_ACRONYMS = new Set([
  "tin", "ssn", "ein", "utr", "nino", "nhs", "nssf", "shif", "nhif",
  "uif", "rssb", "psssf", "pssf", "ahl", "nhis", "paye",
]);
function humaniseId(code: string): string {
  return String(code || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => ID_ACRONYMS.has(p.toLowerCase())
      ? p.toUpperCase()
      : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}
