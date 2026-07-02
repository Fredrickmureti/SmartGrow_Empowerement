/**
 * breakdownAdaptor — pure-TS shared coercion of `payslip_lines.source` into
 * the canonical breakdown view shape consumed by:
 *   - the React widget `BreakdownTable` (browser, Vite)
 *   - the PDF renderer in `generate-payslip-pdf` (Deno)
 *
 * Zero dependencies: no React, no Tailwind, no `npm:` specifiers, no Deno
 * globals. This is the single source of truth for breakdown rendering so
 * the editor's `RuleSimulator`, the runtime payslip explainer popover,
 * and the downloaded PDF stay in lockstep.
 *
 * Supported input shapes (priority order):
 *   1. `{ bracket_breakdown: [{ from|lower, to|upper, rate, base, amount, side?, label? }] }`
 *      Progressive PAYE / banded contributions. Default `side='employee'`.
 *   2. `{ rate, base }` — flat percentage. Synthesised into a single row.
 *   3. `{ employee: [...], employer: [...] }` — pre-split rows.
 *   4. `{ explanation: string|string[] }` — engine-authored prose.
 */

export interface BreakdownRowView {
  label: string;
  amount: number;
  rate?: number;
  base?: number;
}

export interface BreakdownView {
  employeeRows: BreakdownRowView[];
  employerRows: BreakdownRowView[];
  employeeTotal: number;
  employerTotal: number;
  explanation: string[];
}

export interface PayslipLineLike {
  label?: string;
  rule_code?: string;
  employee_amount?: number | null;
  employer_amount?: number | null;
  source?: any;
}

function num(v: any): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function rangeLabel(lower: any, upper: any): string {
  const lo = Number(lower ?? 0).toLocaleString();
  const hi = upper == null ? "∞" : Number(upper).toLocaleString();
  return `${lo} – ${hi}`;
}

/** Adapt one payslip line into the canonical breakdown view. */
export function adaptBracketBreakdown(line: PayslipLineLike): BreakdownView {
  const out: BreakdownView = {
    employeeRows: [],
    employerRows: [],
    employeeTotal: num(line.employee_amount),
    employerTotal: num(line.employer_amount),
    explanation: [],
  };
  const src = line.source ?? {};

  // Shape 3 — pre-split arrays
  if (Array.isArray(src.employee) || Array.isArray(src.employer)) {
    if (Array.isArray(src.employee)) {
      out.employeeRows = src.employee.map((r: any) => ({
        label: r.label ?? r.name ?? "—",
        amount: num(r.amount),
        rate: r.rate,
        base: r.base,
      }));
    }
    if (Array.isArray(src.employer)) {
      out.employerRows = src.employer.map((r: any) => ({
        label: r.label ?? r.name ?? "—",
        amount: num(r.amount),
        rate: r.rate,
        base: r.base,
      }));
    }
  }

  // Shape 1 — bracket_breakdown
  if (
    Array.isArray(src.bracket_breakdown) &&
    out.employeeRows.length === 0 &&
    out.employerRows.length === 0
  ) {
    for (const b of src.bracket_breakdown) {
      const side = b.side === "employer" ? "employer" : "employee";
      const lower = b.from ?? b.lower;
      const upper = b.to ?? b.upper;
      const label = b.label ?? (lower != null || upper != null ? rangeLabel(lower, upper) : "Band");
      const row: BreakdownRowView = {
        label,
        amount: num(b.amount),
        rate: b.rate,
        base: b.base ?? b.taxable,
      };
      (side === "employer" ? out.employerRows : out.employeeRows).push(row);
    }
  }

  // Shape 2 — flat rate fallback
  if (
    out.employeeRows.length === 0 &&
    out.employerRows.length === 0 &&
    (src.rate != null || src.base != null)
  ) {
    const amt = num(line.employee_amount) || num(src.amount);
    out.employeeRows.push({
      label: line.label || line.rule_code || "—",
      amount: amt,
      rate: src.rate,
      base: src.base,
    });
  }

  // Shape 4 — prose
  if (typeof src.explanation === "string") out.explanation.push(src.explanation);
  else if (Array.isArray(src.explanation)) out.explanation.push(...src.explanation.map(String));

  return out;
}

/** Format a breakdown row as a single PDF subnote string ("0–24,000 @ 10% = 2,400"). */
export function formatBreakdownRowForPdf(row: BreakdownRowView, currency?: string): string {
  const parts: string[] = [`   ${row.label}`];
  if (row.rate != null && Number.isFinite(row.rate)) {
    const pct = row.rate > 1 ? row.rate : row.rate * 100;
    parts.push(`@ ${pct.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`);
  }
  const amt = num(row.amount).toLocaleString(undefined, { maximumFractionDigits: 2 });
  parts.push(`= ${currency ? `${currency} ${amt}` : amt}`);
  return parts.join(" ");
}

/** True when a line carries enough information to render a PDF breakdown block. */
export function hasRenderableBreakdown(line: PayslipLineLike): boolean {
  const v = adaptBracketBreakdown(line);
  return v.employeeRows.length > 0 || v.employerRows.length > 0;
}