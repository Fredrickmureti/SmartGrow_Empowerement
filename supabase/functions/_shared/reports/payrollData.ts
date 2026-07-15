/**
 * payrollData — server-build helpers for payroll report keys.
 *
 * Uses the same shape as attendanceData.ts so render-report can
 * dispatch payroll reports through the unified engine. Each row
 * carries a non-enumerable `_meta` so the existing drilldown wires
 * back to /hr/payroll/runs/:id, /hr/payroll/payslips/:id, or to the
 * employee statement.
 *
 * Country-agnostic: rule_code / category come from payslip_lines,
 * which is the authoritative provenance written by compute-payroll.
 * No country-specific tokens are referenced here.
 */
// deno-lint-ignore-file no-explicit-any
import type { ReportResult } from "../reportDataEngine.ts";

export type PayrollReportKey =
  | "payroll_register"
  | "payroll_summary"
  | "employer_contributions"
  | "statutory_liabilities"
  | "employee_earnings"
  | "branch_payroll_cost"
  | "department_payroll_cost"
  | "payroll_overtime"
  | "payroll_variance";

export interface PayrollFilters {
  branchId?: string | null;
  employeeId?: string | null;
  payrollRunId?: string | null;
}

function empName(e: any): string {
  if (!e) return "Unknown";
  return `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || "Unknown";
}

function withMeta(row: any, meta: Record<string, unknown>) {
  return Object.defineProperty(row, "_meta", {
    enumerable: false,
    value: meta,
  });
}

async function loadPayslips(
  supabase: any,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: PayrollFilters,
) {
  // Pull runs in window first, then their payslips + lines. `pay_schedule_id`
  // is projected so payroll_variance can group *within* a schedule instead of
  // mixing runs across schedules by end date (Phase 5e).
  let runQ = supabase
    .from("payroll_runs")
    .select("id, payroll_number, pay_period_start, pay_period_end, status, branch_id, business_id, pay_schedule_id, approved_at")
    .eq("organization_id", orgId)
    .lte("pay_period_start", dateTo)
    .gte("pay_period_end", dateFrom);
  if (businessId) runQ = runQ.eq("business_id", businessId);
  if (filters.branchId) runQ = runQ.eq("branch_id", filters.branchId);
  if (filters.payrollRunId) runQ = runQ.eq("id", filters.payrollRunId);
  const { data: runs = [], error: rErr } = await runQ;
  if (rErr) throw rErr;
  const runIds = runs.map((r: any) => r.id);

  if (runIds.length === 0) {
    return { runs: [], payslips: [], lines: [], employees: [], remittances: [] };
  }

  // Country-agnostic: only header-level totals (gross_pay, net_pay,
  // total_deductions) and identifiers are projected from `payslips`.
  // Every category-specific decomposition (basic, allowances, statutory
  // employee/employer, etc.) is derived from `payslip_lines` below.
  let psQ = supabase
    .from("payslips")
    .select("id, payroll_run_id, employee_id, business_id, branch_id, status, gross_pay, net_pay, total_deductions")
    .in("payroll_run_id", runIds);

  if (filters.employeeId) psQ = psQ.eq("employee_id", filters.employeeId);
  const { data: payslips = [], error: pErr } = await psQ;
  if (pErr) throw pErr;
  const psIds = payslips.map((p: any) => p.id);

  const { data: lines = [] } = psIds.length
    ? await supabase
        .from("payslip_lines")
        .select("payslip_id, payroll_run_id, employee_id, rule_code, rule_type, category, label, employee_amount, employer_amount")
        .in("payslip_id", psIds)
    : { data: [] as any[] };

  const empIds = Array.from(new Set(payslips.map((p: any) => p.employee_id)));
  const { data: employees = [] } = empIds.length
    ? await supabase
        .from("employees")
        .select("id, first_name, last_name, employee_number, branch_id, department_id")
        .in("id", empIds)
    : { data: [] as any[] };

  const { data: remittances = [] } = await supabase
    .from("payroll_remittances")
    .select("payroll_run_id, remittance_type, amount, employer_amount, status")
    .in("payroll_run_id", runIds);

  return { runs, payslips, lines, employees, remittances };
}

export async function buildPayrollReport(
  supabase: any,
  reportType: PayrollReportKey,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: PayrollFilters = {},
): Promise<ReportResult> {
  const { runs, payslips, lines, employees, remittances } = await loadPayslips(
    supabase, orgId, businessId, dateFrom, dateTo, filters,
  );
  const empById = new Map(employees.map((e: any) => [e.id, e]));
  const runById = new Map(runs.map((r: any) => [r.id, r]));
  const linesByPs = new Map<string, any[]>();
  for (const l of lines) {
    const arr = linesByPs.get(l.payslip_id) ?? [];
    arr.push(l);
    linesByPs.set(l.payslip_id, arr);
  }

  const sumEmployee = (ls: any[], cat: string) =>
    ls.filter((l) => l.category === cat).reduce((s, l) => s + Number(l.employee_amount || 0), 0);
  const sumEmployer = (ls: any[]) =>
    ls.reduce((s, l) => s + Number(l.employer_amount || 0), 0);
  const sumEmployeeAll = (ls: any[]) =>
    ls.reduce((s, l) => s + Number(l.employee_amount || 0), 0);

  switch (reportType) {
    case "payroll_register": {
      const rows = payslips.map((p: any) => {
        const e = empById.get(p.employee_id);
        const ls = linesByPs.get(p.id) ?? [];
        const statutory = sumEmployee(ls, "statutory");
        const otherDed = sumEmployee(ls, "deduction");
        const employer = sumEmployer(ls);
        const row = {
          employee: empName(e),
          employee_number: e?.employee_number ?? "—",
          gross: Number(p.gross_pay || 0),
          statutory,
          other_deductions: otherDed,
          employer_cost: employer,
          net_pay: Number(p.net_pay || 0),
        };
        return withMeta(row, {
          sourceDocType: "payslip",
          sourceDocId: p.id,
          partnerType: "employee",
          partnerId: p.employee_id,
        });
      });
      return { data: rows, summary: {
        total_gross: rows.reduce((s, r) => s + r.gross, 0),
        total_net: rows.reduce((s, r) => s + r.net_pay, 0),
        total_employer_cost: rows.reduce((s, r) => s + r.employer_cost, 0),
        employee_count: rows.length,
      } };
    }
    case "payroll_summary": {
      // One row per run with totals.
      const byRun = new Map<string, { count: number; gross: number; ded: number; net: number; employer: number }>();
      for (const p of payslips) {
        const k = p.payroll_run_id;
        const cur = byRun.get(k) ?? { count: 0, gross: 0, ded: 0, net: 0, employer: 0 };
        const ls = linesByPs.get(p.id) ?? [];
        cur.count += 1;
        cur.gross += Number(p.gross_pay || 0);
        cur.ded += Number(p.total_deductions || 0);
        cur.net += Number(p.net_pay || 0);
        cur.employer += sumEmployer(ls);
        byRun.set(k, cur);
      }
      const rows = Array.from(byRun.entries()).map(([runId, t]) => {
        const r = runById.get(runId);
        const row = {
          payroll_number: r?.payroll_number ?? "—",
          period: `${r?.pay_period_start} → ${r?.pay_period_end}`,
          status: r?.status ?? "—",
          employee_count: t.count,
          total_gross: t.gross,
          total_deductions: t.ded,
          total_employer: t.employer,
          total_net: t.net,
        };
        return withMeta(row, { sourceDocType: "payroll_run", sourceDocId: runId });
      });
      return { data: rows, summary: {} };
    }
    case "employer_contributions": {
      // Aggregate employer-side lines by rule_code.
      const agg = new Map<string, { label: string; employees: Set<string>; total: number }>();
      for (const l of lines) {
        const amt = Number(l.employer_amount || 0);
        if (amt === 0) continue;
        const cur = agg.get(l.rule_code) ?? { label: l.label, employees: new Set(), total: 0 };
        cur.employees.add(l.employee_id);
        cur.total += amt;
        agg.set(l.rule_code, cur);
      }
      const rows = Array.from(agg.entries()).map(([code, v]) => {
        const row = {
          rule_code: code,
          label: v.label,
          employee_count: v.employees.size,
          total_employer: v.total,
        };
        return withMeta(row, { sourceDocType: "payroll_liability", ruleCode: code });
      });
      return { data: rows, summary: { grand_total: rows.reduce((s, r) => s + r.total_employer, 0) } };
    }
    case "statutory_liabilities": {
      // Canonical source: `payroll_liabilities` (Phase 5c).
      //
      // The previous implementation filtered `payslip_lines.category === 'statutory'`
      // — a token the compute engine never writes (it emits
      // `statutory_employee` / `statutory_employer` / `income_tax`), so every
      // real tenant saw "No data". Beyond the vocabulary bug, deriving
      // liabilities from lines is architecturally wrong: `payroll_liabilities`
      // is the closed-period, per-obligation table that Statutory Remittances
      // files against. Reports must be a *view* over the same truth, not a
      // parallel derivation.
      let lq = supabase
        .from("payroll_liabilities")
        .select("rule_code, label, authority_name, original_amount, paid_amount, outstanding_amount, period_start, period_end, status")
        .eq("organization_id", orgId)
        .lte("period_start", dateTo)
        .gte("period_end", dateFrom);
      if (businessId) lq = lq.eq("business_id", businessId);
      if (filters.branchId) lq = lq.eq("branch_id", filters.branchId);
      if (filters.payrollRunId) lq = lq.eq("payroll_run_id", filters.payrollRunId);
      const { data: liabs = [], error: lErr } = await lq;
      if (lErr) throw lErr;

      const agg = new Map<string, {
        label: string; authority: string; original: number; paid: number; outstanding: number;
      }>();
      for (const l of liabs as any[]) {
        const cur = agg.get(l.rule_code) ?? {
          label: l.label ?? l.rule_code,
          authority: l.authority_name ?? "—",
          original: 0, paid: 0, outstanding: 0,
        };
        cur.original    += Number(l.original_amount    || 0);
        cur.paid        += Number(l.paid_amount        || 0);
        cur.outstanding += Number(l.outstanding_amount || 0);
        agg.set(l.rule_code, cur);
      }
      const rows = Array.from(agg.entries()).map(([code, v]) => {
        const row = {
          rule_code: code,
          label: v.label,
          authority: v.authority,
          amount_due: v.original,
          paid: v.paid,
          outstanding: v.outstanding,
        };
        return withMeta(row, { sourceDocType: "payroll_liability", ruleCode: code });
      });
      return { data: rows, summary: {
        total_due: rows.reduce((s, r) => s + r.amount_due, 0),
        total_paid: rows.reduce((s, r) => s + r.paid, 0),
        total_outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
      } };
    }
    case "employee_earnings": {
      // Phase 5d — YTD earnings matrix.
      //
      // Rows: employees. Columns: earning `rule_code`s (dynamic). Values:
      // sum of `employee_amount` across payslip_lines whose category is an
      // *earning* bucket. Total column = row sum. This is what an
      // Employee Earnings report actually is on Workday / Oracle HCM /
      // Odoo — a per-component pivot, not a payslip-header dump.
      const isEarning = (l: any) => {
        const c = String(l.category ?? "").toLowerCase();
        return c === "earning" || c === "basic" || c === "allowance" || c === "bonus" || c === "overtime";
      };
      // Dynamic column set.
      const codeLabels = new Map<string, string>();
      for (const l of lines) {
        if (!isEarning(l)) continue;
        if (!codeLabels.has(l.rule_code)) codeLabels.set(l.rule_code, l.label ?? l.rule_code);
      }
      const cols = Array.from(codeLabels.keys()).sort();

      // employee_id -> { rule_code -> amount }
      const cells = new Map<string, Map<string, number>>();
      for (const l of lines) {
        if (!isEarning(l)) continue;
        const row = cells.get(l.employee_id) ?? new Map<string, number>();
        row.set(l.rule_code, (row.get(l.rule_code) ?? 0) + Number(l.employee_amount || 0));
        cells.set(l.employee_id, row);
      }
      const rows = Array.from(cells.entries()).map(([empId, byCode]) => {
        const e = empById.get(empId);
        const row: Record<string, unknown> = {
          employee: empName(e),
          employee_number: e?.employee_number ?? "—",
        };
        let total = 0;
        for (const code of cols) {
          const amt = byCode.get(code) ?? 0;
          row[code] = amt;
          total += amt;
        }
        row.ytd_total = total;
        return withMeta(row, {
          sourceDocType: "employee",
          sourceDocId: empId,
          partnerType: "employee",
          partnerId: empId,
        });
      });
      return { data: rows, summary: {
        employee_count: rows.length,
        earning_components: cols.length,
        columns: cols.map((c) => ({ code: c, label: codeLabels.get(c) ?? c })),
        total_earnings: rows.reduce((s, r) => s + Number((r as any).ytd_total || 0), 0),
      } };
    }
    case "branch_payroll_cost": {
      const byBranch = new Map<string, { count: Set<string>; gross: number; employer: number }>();
      for (const p of payslips) {
        const branchId = p.branch_id ?? "—";
        const cur = byBranch.get(branchId) ?? { count: new Set<string>(), gross: 0, employer: 0 };
        cur.count.add(p.employee_id);
        cur.gross += Number(p.gross_pay || 0);
        cur.employer += sumEmployer(linesByPs.get(p.id) ?? []);
        byBranch.set(branchId, cur);
      }
      // Resolve branch names.
      const branchIds = Array.from(byBranch.keys()).filter((b) => b !== "—");
      const { data: branches = [] } = branchIds.length
        ? await supabase.from("branches").select("id, name").in("id", branchIds)
        : { data: [] as any[] };
      const bName = new Map(branches.map((b: any) => [b.id, b.name]));
      const rows = Array.from(byBranch.entries()).map(([id, v]) => ({
        branch: id === "—" ? "Unassigned" : (bName.get(id) ?? id),
        headcount: v.count.size,
        gross: v.gross,
        employer_cost: v.employer,
        total_cost: v.gross + v.employer,
      }));
      return { data: rows, summary: {} };
    }
    case "department_payroll_cost": {
      // Mirror of branch_payroll_cost but grouped by employee.department_id.
      const byDept = new Map<string, { count: Set<string>; gross: number; employer: number }>();
      for (const p of payslips) {
        const e = empById.get(p.employee_id);
        const deptId = e?.department_id ?? "—";
        const cur = byDept.get(deptId) ?? { count: new Set<string>(), gross: 0, employer: 0 };
        cur.count.add(p.employee_id);
        cur.gross += Number(p.gross_pay || 0);
        cur.employer += sumEmployer(linesByPs.get(p.id) ?? []);
        byDept.set(deptId, cur);
      }
      const deptIds = Array.from(byDept.keys()).filter((d) => d !== "—");
      const { data: depts = [] } = deptIds.length
        ? await supabase.from("departments").select("id, name").in("id", deptIds)
        : { data: [] as any[] };
      const dName = new Map(depts.map((d: any) => [d.id, d.name]));
      const rows = Array.from(byDept.entries()).map(([id, v]) => ({
        department: id === "—" ? "Unassigned" : (dName.get(id) ?? id),
        headcount: v.count.size,
        gross: v.gross,
        employer_cost: v.employer,
        total_cost: v.gross + v.employer,
      }));
      return { data: rows, summary: {} };
    }
    case "payroll_overtime": {
      // Aggregate overtime-flagged payslip lines per employee. Overtime
      // is identified by rule_code/label containing "overtime" (case
      // insensitive) — country-agnostic, matches compute-payroll's
      // canonical convention.
      const isOt = (l: any) =>
        /overtime|over[\s_-]?time|\bOT\b/i.test(String(l.rule_code ?? "")) ||
        /overtime/i.test(String(l.label ?? ""));
      const byEmp = new Map<string, { amount: number; count: number }>();
      for (const l of lines) {
        if (!isOt(l)) continue;
        const cur = byEmp.get(l.employee_id) ?? { amount: 0, count: 0 };
        cur.amount += Number(l.employee_amount || 0);
        cur.count += 1;
        byEmp.set(l.employee_id, cur);
      }
      const rows = Array.from(byEmp.entries()).map(([empId, v]) => {
        const e = empById.get(empId);
        const row = {
          employee: empName(e),
          employee_number: e?.employee_number ?? "—",
          line_count: v.count,
          amount: v.amount,
        };
        return withMeta(row, { partnerType: "employee", partnerId: empId });
      });
      return { data: rows, summary: { total_overtime: rows.reduce((s, r) => s + r.amount, 0) } };
    }
    case "payroll_variance": {
      // Compare each payroll run against the immediately preceding run
      // (chronological by pay_period_end) — gross, deductions, net,
      // employer cost, headcount, with absolute and percent deltas.
      const runTotals = new Map<string, { gross: number; ded: number; net: number; employer: number; count: number }>();
      for (const p of payslips) {
        const k = p.payroll_run_id;
        const cur = runTotals.get(k) ?? { gross: 0, ded: 0, net: 0, employer: 0, count: 0 };
        cur.gross += Number(p.gross_pay || 0);
        cur.ded += Number(p.total_deductions || 0);
        cur.net += Number(p.net_pay || 0);
        cur.employer += sumEmployer(linesByPs.get(p.id) ?? []);
        cur.count += 1;
        runTotals.set(k, cur);
      }
      const ordered = runs
        .filter((r: any) => runTotals.has(r.id))
        .sort((a: any, b: any) => String(a.pay_period_end).localeCompare(String(b.pay_period_end)));
      const pct = (curr: number, prev: number) =>
        prev === 0 ? (curr === 0 ? 0 : 100) : ((curr - prev) / prev) * 100;
      const rows = ordered.map((r: any, idx: number) => {
        const t = runTotals.get(r.id)!;
        const prev = idx > 0 ? runTotals.get(ordered[idx - 1].id) : undefined;
        const row = {
          payroll_number: r.payroll_number ?? "—",
          period: `${r.pay_period_start} → ${r.pay_period_end}`,
          headcount: t.count,
          gross: t.gross,
          net_pay: t.net,
          employer_cost: t.employer,
          gross_delta: prev ? t.gross - prev.gross : 0,
          gross_delta_pct: prev ? Number(pct(t.gross, prev.gross).toFixed(2)) : 0,
          net_delta: prev ? t.net - prev.net : 0,
          net_delta_pct: prev ? Number(pct(t.net, prev.net).toFixed(2)) : 0,
        };
        return withMeta(row, { sourceDocType: "payroll_run", sourceDocId: r.id });
      });
      return { data: rows, summary: {} };
    }
    default:
      throw new Error(`Unknown payroll report key: ${reportType}`);
  }
}