// @ts-nocheck — Deno runtime
/**
 * AnnualEarningsStatementDTO v1 — the canonical, versioned contract for
 * the country-neutral Annual Earnings Statement (ADR-0063).
 *
 * Every field on this shape is derived from canonical payroll history:
 *   - Monthly rows       ← `payroll_employee_monthly_breakdown` RPC
 *   - YTD aggregates     ← `payroll_employee_ytd_rollup` RPC
 *   - Employer identity  ← `organization_statutory_identifiers`
 *   - Employee identity  ← `employee_statutory_identifiers`
 *
 * Templates and pack extensions MUST bind values by dot path (e.g.
 * `ytd.gross`, `months`, `employer.registered_address`) rather than
 * recomputing them. This is enforced by the arch test
 * `src/test/architecture/annual-earnings-canonical-binding.test.ts`.
 */

export const ANNUAL_EARNINGS_DTO_VERSION = "annual-earnings.v1";

export interface AnnualEarningsIdentifier {
  scheme: string;         // pack-provided scheme code (country-neutral)
  label: string;          // human-readable, comes from the pack registry
  value: string;
}

export interface AnnualEarningsEmployer {
  name: string;
  legal_name: string | null;
  registered_address: string | null;
  contact: string | null;
  statutory_identifiers: AnnualEarningsIdentifier[];
}

export interface AnnualEarningsEmployee {
  id: string;
  full_name: string;
  employee_number: string | null;
  department: string | null;
  position: string | null;
  employment_status: string | null;
  employment_period: { from: string | null; to: string | null; label: string };
  statutory_identifiers: AnnualEarningsIdentifier[];
}

/**
 * Canonical monthly row. All 12 months are always present so the matrix
 * renderer can iterate deterministically; unpopulated months are zeroed.
 */
export interface AnnualEarningsMonth {
  month: number;                 // 1..12
  month_index: number;           // 1..12, canonical RPC-facing alias
  gross: number;
  benefits: number;
  taxable: number;
  statutory_employee: number;
  statutory_employer: number;
  other_deductions: number;
  reliefs: number;
  adjustments: number;
  reversals: number;
  leave_payouts: number;
  bonuses: number;
  net: number;
}

export interface AnnualEarningsYtd extends Omit<AnnualEarningsMonth, "month"> {
  employer_contributions_total: number;
  pension_total: number;
  final_settlement: number;
}

export interface AnnualEarningsBreakdownRow {
  rule_code: string;
  category: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
}

export interface AnnualEarningsProvenance {
  run_ids: string[];
  payslip_ids: string[];
  payroll_high_water_mark: string;
  dto_version: string;
  content_hash: string;
  content_hash_short: string;
}

export interface AnnualEarningsStatementDTO {
  dto_version: typeof ANNUAL_EARNINGS_DTO_VERSION;
  period: {
    fiscal_year: number;
    from: string;
    to: string;
    label: string;
    currency: string;
  };
  employer: AnnualEarningsEmployer;
  employee: AnnualEarningsEmployee;
  months: AnnualEarningsMonth[];
  ytd: AnnualEarningsYtd;
  breakdown: {
    earnings: AnnualEarningsBreakdownRow[];
    benefits: AnnualEarningsBreakdownRow[];
    statutory_ee: AnnualEarningsBreakdownRow[];
    statutory_er: AnnualEarningsBreakdownRow[];
    other_deductions: AnnualEarningsBreakdownRow[];
    reliefs: AnnualEarningsBreakdownRow[];
  };
  provenance: AnnualEarningsProvenance;
  extensions: Record<string, unknown>;
  serial_number: string;
  generated_at: string;
  issuer: { name: string | null; title: string | null } | null;
}

/** Zero-filled month template used by the resolver. */
export function emptyMonth(m: number): AnnualEarningsMonth {
  return {
    month: m,
    month_index: m,
    gross: 0, benefits: 0, taxable: 0,
    statutory_employee: 0, statutory_employer: 0,
    other_deductions: 0, reliefs: 0,
    adjustments: 0, reversals: 0, leave_payouts: 0, bonuses: 0,
    net: 0,
  };
}

export function emptyYtd(): AnnualEarningsYtd {
  return {
    gross: 0, benefits: 0, taxable: 0,
    statutory_employee: 0, statutory_employer: 0,
    other_deductions: 0, reliefs: 0,
    adjustments: 0, reversals: 0, leave_payouts: 0, bonuses: 0,
    net: 0,
    employer_contributions_total: 0,
    pension_total: 0,
    final_settlement: 0,
  };
}

/**
 * Category → DTO channel routing. The categories come from
 * `payslip_lines.category` (canonical set: earning, benefit,
 * statutory_employee, statutory_employer, deduction,
 * post_tax_deduction, relief, adjustment, reversal, leave_payout,
 * bonus). Unknown categories are ignored — the base DTO never guesses.
 *
 * Amount-source invariant (documented once, enforced by the resolver):
 *   - channel `statutory_employer` is fed from row.employer_amount
 *   - every other channel is fed from row.employee_amount
 * The resolver is the single site that applies this rule.
 */
export function routeCategoryToChannel(
  cat: string | null | undefined,
):
  | keyof Omit<AnnualEarningsMonth, "month" | "net">
  | null {
  switch ((cat ?? "").toLowerCase()) {
    case "earning": return "gross";
    case "benefit": return "benefits";
    // NOTE: there is no "taxable" category in payslip_lines. The taxable
    // channel is populated from the per-row `taxable_amount` scalar
    // (see annualEarningsResolver), NOT from category routing.
    case "statutory_employee": return "statutory_employee";
    case "statutory_employer": return "statutory_employer";
    case "deduction": return "other_deductions";
    case "post_tax_deduction": return "other_deductions";
    case "relief": return "reliefs";
    case "adjustment": return "adjustments";
    case "reversal": return "reversals";
    case "leave_payout": return "leave_payouts";
    case "bonus": return "bonuses";
    default: return null;
  }
}
