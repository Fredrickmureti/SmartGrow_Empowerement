/**
 * Server-side Payroll Computation Edge Function — v2 (country-agnostic)
 * 
 * AUTHORITATIVE payroll engine. All payroll runs are computed here.
 * 
 * payslip_lines is the AUTHORITATIVE source of truth for all earnings,
 * deductions, and employer contributions. Legacy Kenya-specific columns
 * (paye, nhif, nssf_employee, etc.) are no longer written.
 * 
 * Supports:
 * - Contract-based salary (reads from active employee_contracts)
 * - Salary structures with components (earning/deduction/employer_contribution)
 * - Configurable statutory rules via payroll_statutory_rules table
 * - Explicit computation_method field on rules (no heuristic dispatch)
 * - Variable earnings (overtime, bonuses, commissions) passed as inputs
 * - Proration for partial months (mid-month hires/exits)
 * - Leave deductions (unpaid leave days reduce pay)
 * - Loan auto-deductions with rollback
 * - Benefit plan deductions (employee + employer contributions)
 * - Fiscal period lock enforcement
 * - Dry-run mode for previews (no DB writes)
 * - Atomic insert with rollback
 * - payslip_lines + payslip_inputs provenance (authoritative)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { type InputRef, withInputRef } from "../_shared/inputRef.ts";
import {
  computeGarnishments,
  type GarnishmentOrder,
  type KindDefault,
} from "../_shared/garnishment-engine.ts";
import {
  runStructureEngine,
  type SalaryRule,
  type StructureRuleTrace,
  type WorkEntryType,
  type WorkEntryRow,
} from "./structureEngine.ts";
import { classifyPayslipLine } from "../_shared/payslipClassifier.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function isDuplicatePayrollNumber(error: any) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();
  return text.includes("23505") && text.includes("payroll_number");
}

function isDuplicateRegularPeriod(error: any) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();
  return text.includes("23505") && (
    text.includes("idx_payroll_runs_unique_regular_period") ||
    text.includes("pay_period_start") ||
    text.includes("pay_period_end")
  );
}

interface VariableEarnings {
  employee_id: string;
  overtime_pay?: number;
  bonus?: number;
  commission?: number;
  arrears?: number;
  [key: string]: any;
}

interface PayrollRequest {
  organization_id: string;
  business_id: string | null;
  pay_period_start: string;
  pay_period_end: string;
  payment_date?: string;
  employee_ids: string[];
  country_code: string | null;
  dry_run?: boolean;
  variable_earnings?: VariableEarnings[];
  /**
   * Run intent. 'regular' is the standard cycle; only one regular run per
   * (org, business, period) is allowed. All other types may coexist with the
   * regular run for the same period (off-cycle / supplemental / bonus /
   * commission / 13th-month / termination / correction). Defaults to 'regular'.
   */
  run_type?:
    | "regular"
    | "off_cycle"
    | "supplemental"
    | "bonus"
    | "commission"
    | "13th_month"
    | "termination"
    | "correction";
  /** Required for run_type IN ('correction','supplemental'). The posted run this one adjusts. */
  parent_run_id?: string | null;
  /**
   * Optional payroll_periods.id. When supplied, the engine derives the pay
   * window from the row and rejects the run if the period is locked/closed.
   * Keeps caller-supplied `pay_period_start`/`pay_period_end` as a fallback
   * for ad-hoc runs (back-compat).
   */
  period_id?: string | null;
  /**
   * Optional per-employee proration overrides. When `full_period: true`, the
   * engine forces prorationFactor = 1 for that employee regardless of their
   * hire_date / termination_date falling inside the period. `reason` is
   * required (audit-trail) and is surfaced in run warnings and on the
   * payslip input rows. Intended for policy decisions like "employee hired
   * end-of-month, first payroll covers full month".
   */
  proration_overrides?: Record<string, { full_period: boolean; reason: string }>;
}

interface PayrollRule {
  id: string;
  rule_type: string;
  rule_name: string;
  /** Stable per-rule code (PAYE, NSSF, SHIF, AHL, NHIF…). Backfilled by migration
   *  20260508_payroll_rule_code from a slug of rule_name when the localization
   *  pack didn't provide one explicitly. NEVER reuse rule_type as a line key —
   *  many distinct rules share rule_type='statutory_deduction'. */
  rule_code: string;
  parameters: Record<string, any>;
  sort_order: number;
  computation_method: string;
  /** Phase 4 P1.1: pack release that shipped this rule. Stamped onto payslip
   *  lines so every statutory amount can be traced to the exact pack version. */
  pack_version_id?: string | null;
}

interface PayrollDeduction {
  rule_type: string;
  label: string;
  employee_amount: number;
  employer_amount: number;
}

interface PayrollSettings {
  standard_working_days: number;
  standard_hours_per_day: number;
  overtime_multiplier: number;
}

const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  standard_working_days: 22,
  standard_hours_per_day: 8,
  overtime_multiplier: 1.5,
};

// ─── Proration Helper ────────────────────────────────────────────────────

function calculateProrationFactor(
  periodStart: string,
  periodEnd: string,
  hireDate: string | null,
  terminationDate: string | null
): number {
  const pStart = new Date(periodStart);
  const pEnd = new Date(periodEnd);
  const totalDays = Math.round((pEnd.getTime() - pStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  let effectiveStart = pStart;
  let effectiveEnd = pEnd;
  
  if (hireDate) {
    const hire = new Date(hireDate);
    if (hire > pStart) effectiveStart = hire;
  }
  
  if (terminationDate) {
    const term = new Date(terminationDate);
    if (term < pEnd) effectiveEnd = term;
  }
  
  if (effectiveStart > effectiveEnd) return 0;
  
  const workedDays = Math.round((effectiveEnd.getTime() - effectiveStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  return Math.min(1, workedDays / totalDays);
}

// ─── Calculation Engine (per-rule, contract-driven) ─────────────────────
//
// Each rule from `payroll_statutory_rules` carries an explicit
// `computation_method` and a `parameters` payload whose shape matches that
// method. The engine NEVER guesses — unknown / "auto" rules are pushed to
// the skipped sink and surfaced as `payroll_run_issues` so accountants see
// them instead of silently zero-ing the payslip.
//
// Rate inputs from localization packs are stored as percent NUMBERS
// (1.5 means 1.5%, 2.75 means 2.75%). The engine divides by 100 once,
// here, so callers and packs only ever talk in percent.

interface CalcContext {
  grossPay: number;
  taxableIncome: number;
  basicSalary: number;
  /**
   * Per-rule input values resolved from the employee record via the input
   * registry below. Rules read what they need via `ctx.inputs[name]`.
   * NEVER add country-specific fields directly on CalcContext — declare a
   * new input in `EMPLOYEE_INPUT_REGISTRY` and reference it from the rule's
   * `parameters` instead. This keeps the engine country-agnostic.
   */
  inputs: Record<string, number>;
}

/**
 * Maps a `parameters.requires_input[]` token (or a parameter that the
 * engine reads from `ctx.inputs[...]`) to the employee column that supplies
 * the value. Adding a new statutory input is a single-line change here
 * plus a `requires_input: [...]` entry on the localization-pack rule — no
 * country branches anywhere.
 */
// Every token that a localization pack rule can reference in
// `parameters.requires_input[]`, `pickBase(...)`, `parameters.reliefs[].base_code`,
// or `parameters.reliefs[].condition` must be resolvable through this
// registry. Keys are pure tokens — never a country literal. The values
// are populated by the pre-fetch pass below (see aggregatePreTaxInputs).
//
// Adding a new statutory input is a one-line change here plus a
// `requires_input: [...]` entry on the localization-pack rule.
const EMPLOYEE_INPUT_REGISTRY: Record<string, (emp: any) => number> = {
  insurance_premium: (emp) => Number(emp?.insurance_premium ?? 0),
  ahr_contribution: (emp) => Number(emp?.ahr_contribution ?? 0),
  mortgage_interest: (emp) => Number(emp?.mortgage_interest ?? 0),
  pension_contribution: (emp) => Number(emp?.pension_contribution ?? 0),
  post_retirement_medical: (emp) => Number(emp?.post_retirement_medical ?? 0),
  // Presence-only gate tokens. Coerced to 1/0 so the same map is uniformly
  // numeric; relief `condition` checks read truthiness.
  ahr_contribution_present: (emp) => (Number(emp?.ahr_contribution ?? 0) > 0 ? 1 : 0),
  disability_certified: (emp) => (emp?.disability_certified ? 1 : 0),
};

/**
 * ADR-0010 Gap #2 — data-driven inputs.
 *
 * `dynamicKeys` are token names loaded from `pack_token_registry` where
 * `source='employee'`, resolved once per payroll run. Each dynamic key
 * reads `emp[key]` (coerced to Number, missing = 0), so a pack that
 * registers a new employee-sourced token — e.g. Ghana Tier-3 voluntary
 * contribution — becomes engine-visible with zero engine edits.
 *
 * Built-in getters win on collision so existing packs stay byte-identical.
 *
 * `variableInputs` are per-run variable earnings (bonus_amount,
 * overtime_amount, commission, …) forwarded from `variable_earnings[]`;
 * these OVERRIDE the emp-column read so a one-off bonus paid this cycle
 * is visible to `bonus_windfall` / `overtime_concessional` rules without
 * having to persist it on the employee row.
 */
function resolveInputs(
  emp: any,
  dynamicKeys: string[] = [],
  variableInputs: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of dynamicKeys) {
    if (!key || key in EMPLOYEE_INPUT_REGISTRY) continue;
    out[key] = Number(emp?.[key] ?? 0) || 0;
  }
  for (const [key, getter] of Object.entries(EMPLOYEE_INPUT_REGISTRY)) {
    out[key] = getter(emp);
  }
  for (const [key, val] of Object.entries(variableInputs)) {
    if (val == null) continue;
    out[key] = Number(val) || 0;
  }
  return out;
}

interface RuleResult {
  rule_id: string;
  rule_type: string;
  rule_name: string;
  label: string;
  employee_amount: number;
  employer_amount: number;
  category: "statutory_employee" | "statutory_employer";
}

/**
 * Per-tier audit trail emitted by `computeBracketProgressive`. Surfaced as
 * `payroll_run_issues` rows (severity=info) so accountants can explain how
 * any progressive tax was derived without re-running the engine.
 */
interface BracketTraceTier {
  lower: number;
  upper: number | null;
  rate_pct: number;
  slab: number;
  tax: number;
}
interface BracketTrace {
  rule_id: string;
  rule_code: string;
  rule_name: string;
  income: number;
  tiers: BracketTraceTier[];
  gross_tax: number;
  personal_relief: number;
  insurance_relief: number;
  final_tax: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: unknown) => (Number(n) || 0) / 100;

const VALID_PAYSLIP_LINE_CATEGORIES = new Set([
  "earning",
  "deduction",
  "employer_contribution",
  "statutory_employee",
  "statutory_employer",
  "reimbursement",
  "benefit",
  "loan_repayment",
  "net",
  "subtotal",
  "pre_tax_deduction",
  "tax",
  "relief",
  "post_tax_deduction",
]);

const LEGACY_PAYSLIP_LINE_CATEGORY_MAP: Record<string, string> = {
  garnishment: "post_tax_deduction",
  reimbursement: "earning",
};

function normalizePayslipLineCategory(category: unknown): string {
  const raw = String(category ?? "").trim();
  if (VALID_PAYSLIP_LINE_CATEGORIES.has(raw)) return raw;
  const mapped = LEGACY_PAYSLIP_LINE_CATEGORY_MAP[raw];
  if (mapped) return mapped;
  console.warn(`[compute-payroll] unknown payslip line category "${raw}" normalized to deduction`);
  return "deduction";
}

function normalizePayslipLineRow(row: Record<string, any>): Record<string, any> {
  const normalizedCategory = normalizePayslipLineCategory(row.category);
  if (normalizedCategory === row.category) return row;
  return {
    ...row,
    category: normalizedCategory,
    source: {
      ...(row.source || {}),
      original_category: row.category,
      normalized_category: normalizedCategory,
    },
  };
}

function pickBase(params: Record<string, any>, ctx: CalcContext): number {
  const base = (params.base || "gross_pay").toString().toLowerCase();
  if (base === "taxable_income" || base === "taxable") return ctx.taxableIncome;
  if (base === "basic" || base === "basic_salary") return ctx.basicSalary;
  return ctx.grossPay;
}

export function computeBracketProgressive(
  rule: PayrollRule,
  ctx: CalcContext,
  traceSink?: BracketTrace[],
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const brackets: Array<any> = Array.isArray(p.brackets) ? p.brackets : [];
  if (brackets.length === 0) return { employee: 0, employer: 0 };

  // Base income for the tax. Default = taxable income (PAYE-style).
  const income = pickBase({ base: p.base ?? "taxable_income" }, ctx);

  let tax = 0;
  const tiers: BracketTraceTier[] = [];
  for (const b of brackets) {
    const lower = Number(b.min ?? b.lower ?? 0);
    // Accept either `max` or `upper` as the ceiling alias. A tier is only
    // unbounded when BOTH aliases are absent — otherwise packs that ship
    // one alias (the norm) silently collapse to Infinity on every tier,
    // taxing the full income at tier-1 only.
    const rawUpper = b.max ?? b.upper;
    const upper = rawUpper == null ? Infinity : Number(rawUpper);
    const rate = pct(b.rate);
    if (income <= lower) break;
    const slabTop = Math.min(income, upper);
    const slab = Math.max(0, slabTop - lower);
    const tierTax = slab * rate;
    tax += tierTax;
    tiers.push({
      lower,
      upper: upper === Infinity ? null : upper,
      rate_pct: Number(b.rate) || 0,
      slab: round2(slab),
      tax: round2(tierTax),
    });
    if (income <= upper) break;
  }

  // Reliefs. Two encodings, both supported so the pack is the single
  // source of truth (audit 2026-07-05, plan §R2):
  //   (A) Scalars on the tax rule — `personal_relief`, `insurance_relief_rate`,
  //       `insurance_relief_max` — legacy shape, still honoured.
  //   (B) Declarative `parameters.reliefs[]` — each entry carries
  //       `kind` in {flat, rate_of_base, deduction_cap, exemption} plus
  //       amount/rate/cap/base_code/condition. deduction_cap and exemption
  //       are applied upstream (Pass A / pre-tax); here we only honour the
  //       kinds that reduce the tax bill directly: flat and rate_of_base.
  //   The union prevents double-counting: if a scalar AND a matching
  //   reliefs[] entry both exist, the scalar wins (idempotent w/ legacy).
  const scalarPersonalRelief = Number(p.personal_relief ?? 0);
  const scalarIrRate = p.insurance_relief_rate != null ? pct(p.insurance_relief_rate) : 0;
  const scalarIrCap = Number(p.insurance_relief_max ?? p.insurance_relief_cap ?? 0);
  const insurancePremium = Number(ctx.inputs?.insurance_premium ?? 0);

  let personalRelief = scalarPersonalRelief;
  let insuranceRelief = scalarPersonalRelief > 0 || scalarIrRate > 0
    ? (insurancePremium > 0 && scalarIrRate > 0
        ? Math.min(insurancePremium * scalarIrRate, scalarIrCap || Infinity)
        : 0)
    : 0;

  const reliefsArr: Array<any> = Array.isArray(p.reliefs) ? p.reliefs : [];
  for (const r of reliefsArr) {
    if (!r || typeof r !== "object") continue;
    const kind = String(r.kind ?? "").toLowerCase();
    const code = String(r.code ?? "").toLowerCase();
    // Optional gating: `condition` is a token key in ctx.inputs. If declared
    // and falsy, the relief is skipped. Keeps things declarative — no
    // literal rule_code branches.
    if (r.condition) {
      const gate = ctx.inputs?.[String(r.condition)];
      if (!gate) continue;
    }
    if (kind === "flat") {
      // Scalar personal_relief already covers this — avoid double-count.
      if (code === "personal_relief" && scalarPersonalRelief > 0) continue;
      personalRelief += Number(r.amount ?? 0);
    } else if (kind === "rate_of_base") {
      if (code === "insurance_relief" && scalarIrRate > 0) continue;
      const baseCode = String(r.base_code ?? "").toLowerCase();
      const baseAmt = Number(ctx.inputs?.[baseCode] ?? 0);
      if (baseAmt <= 0) continue;
      const rate = pct(r.rate != null ? (Number(r.rate) > 1 ? r.rate : Number(r.rate) * 100) : 0);
      const cap = Number(r.cap ?? 0) || Infinity;
      insuranceRelief += Math.min(baseAmt * rate, cap);
    }
    // `deduction_cap` and `exemption` are applied upstream in Pass A
    // (see compute-payroll main loop, "Employee-input pre-tax deductions"
    // and "Exemption reliefs" blocks). Skipped here by design.
  }

  const grossTax = tax;
  tax = tax - personalRelief - insuranceRelief;
  const finalTax = Math.max(0, round2(tax));
  if (traceSink) {
    traceSink.push({
      rule_id: rule.id,
      rule_code: rule.rule_code,
      rule_name: rule.rule_name,
      income,
      tiers,
      gross_tax: round2(grossTax),
      personal_relief: round2(personalRelief),
      insurance_relief: round2(insuranceRelief),
      final_tax: finalTax,
    });
  }
  return { employee: finalTax, employer: 0 };
}

export function computeTieredBrackets(
  rule: PayrollRule,
  ctx: CalcContext,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const tiers: Array<any> = Array.isArray(p.tiers) ? p.tiers : [];
  const income = pickBase(p, ctx);
  let employee = 0;
  let employer = 0;

  for (const t of tiers) {
    const lower = Number(t.lower_earnings_limit ?? t.min ?? 0);
    const upper = t.upper_earnings_limit == null ? Infinity : Number(t.upper_earnings_limit);
    if (income <= lower) break;
    const slab = Math.max(0, Math.min(income, upper) - lower);
    employee += slab * pct(t.employee_rate ?? t.rate);
    employer += slab * pct(t.employer_rate ?? t.rate);
    if (income <= upper) break;
  }

  // Optional cap per tier or rule-wide. Packs and editors historically
  // use either `cap` or `ceiling` for the same concept — Phase 2 accepts
  // both aliases so authoring-time UI (which writes `ceiling`) matches
  // engine semantics (which read `cap`).
  const cap = Number(p.cap ?? p.ceiling ?? Infinity);
  return { employee: Math.min(round2(employee), cap), employer: Math.min(round2(employer), cap) };
}

export function computePercentageOfBase(
  rule: PayrollRule,
  ctx: CalcContext,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const base = pickBase(p, ctx);
  const employeeOnly = !!p.employee_only;
  const employerOnly = !!p.employer_only;
  const empRate = pct(p.employee_rate ?? (employerOnly ? 0 : p.rate ?? 0));
  const erRate  = pct(p.employer_rate ?? (employeeOnly ? 0 : (p.employer_rate ?? 0)));
  // `ceiling` alias — see computeTieredBrackets note. Phase 2 alignment.
  const cap = Number(p.cap ?? p.ceiling ?? Infinity);
  return {
    employee: Math.min(round2(base * empRate), cap),
    employer: Math.min(round2(base * erRate), cap),
  };
}

function computeGraduatedTable(
  rule: PayrollRule,
  ctx: CalcContext,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const brackets: Array<any> = Array.isArray(p.brackets) ? p.brackets : [];
  const income = pickBase(p, ctx);
  for (const b of brackets) {
    const lower = Number(b.min ?? b.lower ?? 0);
    const upper = b.max == null ? Infinity : Number(b.max);
    if (income >= lower && income <= upper) {
      return { employee: Number(b.amount ?? 0), employer: 0 };
    }
  }
  // Fall through to last bracket if income above the table
  const last = brackets[brackets.length - 1];
  return { employee: Number(last?.amount ?? 0), employer: 0 };
}

function computeFlatAmount(
  rule: PayrollRule,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const employeeOnly = !!p.employee_only;
  const employerOnly = !!p.employer_only;
  return {
    employee: employerOnly ? 0 : Number(p.amount ?? p.employee_amount ?? 0),
    employer: employeeOnly ? 0 : Number(p.employer_amount ?? 0),
  };
}

function computePerEmployeeFlat(
  rule: PayrollRule,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const amt = Number(p.amount_per_employee ?? p.amount ?? 0);
  return p.employer_only ? { employee: 0, employer: amt } : { employee: amt, employer: 0 };
}

// ─── ADR-0010 Gap #3 — flat / bonus_windfall / overtime_concessional ────
//
// Country-agnostic income-tax computation methods added for Ghana's
// non-resident PAYE, bonus tax, and overtime QJE. All three are pure
// functions off `parameters` — no rule_code branches.

/**
 * `income_tax / flat` — single-rate tax on the whole taxable base.
 * Used for non-resident PAYE and expat withholding. `parameters.residency`
 * gates against `ctx.inputs.is_non_resident` (1 = non-resident, 0/absent
 * = resident) so packs can ship resident + non-resident rules side-by-side.
 */
export function computeFlatIncomeTax(
  rule: PayrollRule,
  ctx: CalcContext,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const residency = String(p.residency ?? "any").toLowerCase();
  if (residency !== "any") {
    const isNonRes = (ctx.inputs?.is_non_resident ?? 0) > 0;
    if (residency === "resident" && isNonRes) return { employee: 0, employer: 0 };
    if (residency === "non_resident" && !isNonRes) return { employee: 0, employer: 0 };
  }
  const baseCode = String(p.base_code ?? "taxable_income").toLowerCase();
  const base = baseCode === "gross_pay" ? ctx.grossPay
             : baseCode === "basic_salary" || baseCode === "basic" ? ctx.basicSalary
             : baseCode === "taxable_income" || baseCode === "taxable" ? ctx.taxableIncome
             : Number(ctx.inputs?.[baseCode] ?? 0);
  const minTaxable = Number(p.min_taxable ?? 0);
  if (base <= minTaxable) return { employee: 0, employer: 0 };
  const tax = (base - minTaxable) * pct(p.rate_percent ?? 0);
  return { employee: round2(Math.max(0, tax)), employer: 0 };
}

/**
 * `income_tax / bonus_windfall` — concessional flat rate on bonuses up
 * to a threshold expressed as %% of annual basic; excess rolls into
 * ordinary PAYE (Ghana 5% ≤ 15% of annual basic).
 *
 * The engine only computes the CONCESSIONAL portion here — the excess
 * is exposed via `ctx.inputs['bonus_rolled_to_paye']` (set as a side
 * effect) so the sibling PAYE bracket_progressive rule automatically
 * taxes it through its normal path. Callers who don't ship a matching
 * `input_code` (default `bonus_amount`) get zero, which is correct for
 * a regular run with no bonus paid.
 */
export function computeBonusWindfall(
  rule: PayrollRule,
  ctx: CalcContext,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const inputCode = String(p.input_code ?? "bonus_amount");
  const bonus = Number(ctx.inputs?.[inputCode] ?? 0);
  if (bonus <= 0) return { employee: 0, employer: 0 };

  const annualBasicToken = String(p.annual_basic_token ?? "").toLowerCase();
  const annualBasic = annualBasicToken && ctx.inputs?.[annualBasicToken] != null
    ? Number(ctx.inputs[annualBasicToken])
    : ctx.basicSalary * 12;
  const thresholdPct = pct(p.threshold_pct_of_annual_basic ?? 0);
  const cap = annualBasic * thresholdPct;

  const qualifying = Math.min(bonus, cap);
  const excess = Math.max(0, bonus - cap);
  const tax = qualifying * pct(p.flat_rate_percent ?? 0);

  const excessTreatment = String(p.excess_treatment ?? "roll_to_paye").toLowerCase();
  if (excessTreatment === "roll_to_paye") {
    ctx.inputs.bonus_rolled_to_paye = (ctx.inputs.bonus_rolled_to_paye ?? 0) + excess;
  }
  return { employee: round2(tax), employer: 0 };
}

/**
 * `income_tax / overtime_concessional` — concessional overtime rate up
 * to a monthly cash cap; excess taxed via ordinary PAYE (Ghana QJE:
 * 5% up to GHS 18,000/month, junior-only).
 */
export function computeOvertimeConcessional(
  rule: PayrollRule,
  ctx: CalcContext,
): { employee: number; employer: number } {
  const p = rule.parameters || {};
  const inputCode = String(p.input_code ?? "overtime_amount");
  const overtime = Number(ctx.inputs?.[inputCode] ?? 0);
  if (overtime <= 0) return { employee: 0, employer: 0 };

  // Junior-only gate. When required, employees must expose a truthy
  // `qualifying_junior` input; if not exposed, the rule is skipped.
  if (p.qualifying_junior_only !== false) {
    const isJunior = (ctx.inputs?.qualifying_junior ?? 0) > 0;
    if (!isJunior) return { employee: 0, employer: 0 };
  }

  const cap = Number(p.monthly_cash_cap ?? 0);
  const qualifying = cap > 0 ? Math.min(overtime, cap) : overtime;
  const excess = Math.max(0, overtime - qualifying);
  const tax = qualifying * pct(p.flat_rate_percent ?? 0);

  const excessTreatment = String(p.excess_treatment ?? "roll_to_paye").toLowerCase();
  if (excessTreatment === "roll_to_paye") {
    ctx.inputs.overtime_rolled_to_paye = (ctx.inputs.overtime_rolled_to_paye ?? 0) + excess;
  }
  return { employee: round2(tax), employer: 0 };
}


/**
 * Phase 3.6 — Bonus/13th-month/commission tax-method dispatch.
 *
 * For `bracket_progressive` rules (PAYE-style), the engine normally computes
 * tax against the current period's taxable income. On non-regular runs this
 * over-withholds: a single-period bonus pushes the employee into higher
 * brackets that the brackets table was never meant to apply to one payment.
 *
 * Real ERP payroll engines dispatch via a configured tax_method on the run
 * type policy. Supported methods (parity with SAP/Workday vocabulary):
 *
 *   - `ordinary`      — no-op. Current per-period bracket calc.
 *   - `annualized`    — scale income × periods_per_year, run brackets,
 *                       divide annual tax by periods_per_year. Standard
 *                       approach for one-off bonuses on a regular schedule.
 *   - `separate_rate` — tax the income at a flat statutory supplemental
 *                       rate (e.g. 22% US supplemental wage). Reads
 *                       `parameters.separate_rate_pct`. Refuses if missing.
 *   - `aggregate`     — YTD-aware "true marginal" method. Requires a YTD
 *                       income context we do not yet capture inside the
 *                       engine; falls back to `ordinary` and emits a
 *                       BONUS_TAX_METHOD_FALLBACK issue.
 *
 * The dispatcher only applies to `bracket_progressive` rules. Other methods
 * (percentage_of_gross, flat_amount, tiered) pass through unchanged because
 * they are not income-tax curves that bracket creep distorts.
 */
export function applyTaxMethod(
  rule: PayrollRule,
  ctx: CalcContext,
  method: string,
  periodsPerYear: number,
  fallbackSink?: Array<{ rule_code: string; rule_name: string; requested_method: string; reason: string }>,
  traceSink?: BracketTrace[],
): { employee: number; employer: number } | null {
  const m = (method || "ordinary").toLowerCase();
  if ((rule.computation_method || "").toLowerCase() !== "bracket_progressive") {
    return null; // dispatcher only meaningful for bracket curves
  }

  if (m === "ordinary" || !m) return null;

  if (m === "annualized") {
    const ppy = Math.max(1, Math.floor(periodsPerYear || 12));
    const periodTaxable = Number(ctx.taxableIncome || 0);
    const annualCtx: CalcContext = { ...ctx, taxableIncome: periodTaxable * ppy };
    const annualRes = computeBracketProgressive(rule, annualCtx, traceSink);
    return {
      employee: round2(annualRes.employee / ppy),
      employer: round2(annualRes.employer / ppy),
    };
  }

  if (m === "separate_rate") {
    const p = (rule.parameters || {}) as Record<string, unknown>;
    const rawRate = (p as any).separate_rate_pct ?? (p as any).supplemental_rate_pct;
    const ratePct = rawRate == null ? NaN : Number(rawRate);
    if (!Number.isFinite(ratePct) || ratePct < 0) {
      fallbackSink?.push({
        rule_code: rule.rule_code,
        rule_name: rule.rule_name,
        requested_method: m,
        reason: "rule.parameters.separate_rate_pct missing or invalid",
      });
      return null; // caller falls back to ordinary
    }
    const tax = Math.max(0, Number(ctx.taxableIncome || 0)) * (ratePct / 100);
    return { employee: round2(tax), employer: 0 };
  }

  if (m === "aggregate") {
    fallbackSink?.push({
      rule_code: rule.rule_code,
      rule_name: rule.rule_name,
      requested_method: m,
      reason: "aggregate (YTD-marginal) method requires YTD context not yet wired into the engine",
    });
    return null;
  }

  // Unknown method — refuse silently; caller falls back to ordinary.
  fallbackSink?.push({
    rule_code: rule.rule_code,
    rule_name: rule.rule_name,
    requested_method: m,
    reason: `unknown tax_method '${m}'`,
  });
  return null;
}

/**
 * Phase 3.6 — Infer periods-per-year from the pay period length.
 * Conservative heuristic; refined by the run-type policy when it grows a
 * periods_per_year column. Keep the table in lockstep with payroll_settings.
 */
export function inferPeriodsPerYear(periodStart: string, periodEnd: string): number {
  try {
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days <= 8) return 52;   // weekly
    if (days <= 16) return 26;  // biweekly
    if (days <= 17) return 24;  // semimonthly
    if (days <= 35) return 12;  // monthly
    if (days <= 95) return 4;   // quarterly
    return 12;
  } catch {
    return 12;
  }
}


export function computeOneRule(
  rule: PayrollRule,
  ctx: CalcContext,
  skippedSink?: Set<string>,
  traceSink?: BracketTrace[],
): RuleResult | null {
  const method = (rule.computation_method || "").toLowerCase();
  let result: { employee: number; employer: number };

  switch (method) {
    case "bracket_progressive":
      result = computeBracketProgressive(rule, ctx, traceSink);
      break;
    case "tiered_brackets":
    case "tiered":
      result = computeTieredBrackets(rule, ctx);
      break;
    case "percentage_of_gross":
    case "percentage":
      result = computePercentageOfBase(rule, ctx);
      break;
    case "graduated_table":
    case "graduated":
      result = computeGraduatedTable(rule, ctx);
      break;
    case "flat_amount":
    case "fixed":
      result = computeFlatAmount(rule);
      break;
    case "per_employee_flat":
      result = computePerEmployeeFlat(rule);
      break;
    // ADR-0010 Gap #3 — country-agnostic income-tax methods.
    case "flat":
    case "flat_rate":
      result = computeFlatIncomeTax(rule, ctx);
      break;
    case "bonus_windfall":
      result = computeBonusWindfall(rule, ctx);
      break;
    case "overtime_concessional":
      result = computeOvertimeConcessional(rule, ctx);
      break;
    case "":
    case "auto":
    default:
      // Refuse to guess. Surface as a payroll_run_issues row.
      skippedSink?.add(`${rule.id}|${rule.rule_type}|${rule.rule_name}|${method || "auto"}`);
      return null;
  }

  if (result.employee === 0 && result.employer === 0) return null;

  // Employer-only rules go into the contributions bucket; everything else
  // is an employee-side statutory deduction (employer side, if any, is
  // ALSO surfaced as a contribution line).
  return {
    rule_id: rule.id,
    rule_type: rule.rule_type,
    rule_name: rule.rule_name,
    label: rule.rule_name,
    employee_amount: result.employee,
    employer_amount: result.employer,
    category: "statutory_employee",
  };
}

// ─── Main Handler ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Hoisted so the outer catch can finalize the job row even when the
  // engine throws before/after the id is assigned.
  let jobId: string | null = null;
  let idempotencyKey: string | null = null;
  let supabaseAdminOuter: ReturnType<typeof createClient> | null = null;

  // Enterprise execution model — accept vs. execute split.
  //
  // The UI POST is the ACCEPT call: it authenticates the user, creates the
  // `payroll_run_jobs` control row, and immediately returns HTTP 202 with
  // `{ job_id, status: "queued" }`. The browser subscribes to
  // `payroll_run_jobs` over realtime and observes authoritative server
  // state from that point on — no HTTP promise, no "did it work?" toast.
  //
  // Execution happens in a second, self-invoked HTTP call that carries
  // `X-Payroll-Worker: 1`. That worker call re-runs this same function,
  // detects the header, skips the accept branch, and runs the engine to
  // completion (or to a heartbeat-timeout the DB sweeper will reap).
  //
  // Why self-invoke instead of an in-process background task: a Supabase
  // edge-function isolate can be torn down as soon as its Response is
  // returned. `EdgeRuntime.waitUntil` on `fetch(...)` guarantees the
  // outbound worker request is *dispatched*, giving the worker its own
  // isolate with a fresh 400s budget — the engine is no longer coupled
  // to the caller's socket or to a single isolate lifetime.
  const isWorkerInvocation =
    (req.headers.get("x-payroll-worker") ?? "").trim() === "1";

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    supabaseAdminOuter = supabaseAdmin;

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;

    // Parse request
    const body: PayrollRequest = await req.json();
    const {
      organization_id, business_id, period_id = null,
      employee_ids, country_code, dry_run = false, variable_earnings = [],
      proration_overrides = {},
    } = body;
    let { pay_period_start, pay_period_end } = body;

    // ─── Phase timer ───────────────────────────────────────────────────
    // Lightweight instrumentation so we can pinpoint which section of the
    // engine consumes the wall clock when a preview times out on the client.
    // Emits one structured line per phase with elapsed-since-start and
    // elapsed-since-previous-phase in milliseconds.
    const _phaseT0 = Date.now();
    let _phaseLast = _phaseT0;
    const phase = (label: string, extra?: Record<string, unknown>) => {
      const now = Date.now();
      const total = now - _phaseT0;
      const delta = now - _phaseLast;
      _phaseLast = now;
      console.log(
        `[compute-payroll:phase] ${label} +${delta}ms total=${total}ms` +
          (extra ? ` ${JSON.stringify(extra)}` : ""),
      );
    };
    phase("request-parsed", { dry_run, employees: employee_ids?.length ?? 0 });

    // Heartbeat helper — the DB sweeper marks a job failed if it has not
    // heard from the worker in 5 minutes. Update phase + heartbeat_at at
    // meaningful transitions so the UI can render live status.
    const heartbeat = async (
      nextPhase: string,
      progress?: { current?: number; total?: number },
    ) => {
      if (!jobId) return;
      try {
        await supabaseAdminOuter!
          .from("payroll_run_jobs")
          .update({
            phase: nextPhase,
            heartbeat_at: new Date().toISOString(),
            ...(progress?.current != null ? { progress_current: progress.current } : {}),
            ...(progress?.total != null ? { progress_total: progress.total } : {}),
          })
          .eq("id", jobId);
      } catch (e) {
        // Never let observability failures kill the engine.
        console.error("[compute-payroll] heartbeat failed:", (e as Error).message);
      }
    };
    const isCancelled = async (): Promise<boolean> => {
      if (!jobId) return false;
      try {
        const { data } = await supabaseAdminOuter!
          .from("payroll_run_jobs")
          .select("cancel_requested_at")
          .eq("id", jobId)
          .maybeSingle();
        return !!(data as any)?.cancel_requested_at;
      } catch {
        return false;
      }
    };

    // ─── Period management: when period_id is supplied, the period row is
    // the source of truth for the window and lock state. Caller-supplied
    // dates are only used as a fallback (back-compat). ───
    let resolvedPeriodId: string | null = period_id ?? null;
    if (resolvedPeriodId) {
      const { data: periodRow, error: periodErr } = await supabaseAdmin
        .from("payroll_periods")
        .select("id, start_date, end_date, status, organization_id, business_id")
        .eq("id", resolvedPeriodId)
        .maybeSingle();
      if (periodErr || !periodRow) {
        return new Response(JSON.stringify({ error: "payroll_period not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (periodRow.organization_id !== organization_id) {
        return new Response(JSON.stringify({ error: "payroll_period does not belong to this organization" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (["locked", "closed"].includes(String(periodRow.status))) {
        return new Response(JSON.stringify({
          error: `Payroll period is ${periodRow.status}. Reopen it before running payroll.`,
        }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      pay_period_start = periodRow.start_date;
      pay_period_end = periodRow.end_date;
    }

    if (!organization_id || !pay_period_start || !pay_period_end || !employee_ids?.length) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Phase 2 · Idempotency + job control row ───────────────────────
    // The client sends `idempotency_key` on every invoke. If a transport
    // failure led the UI to retry the same submit, we MUST NOT run the
    // engine twice — that produces duplicate payslips. We check for an
    // existing job under the same (org, key); if it's already succeeded we
    // replay the stored result, if it's still running we tell the caller to
    // wait, and if it failed we allow a fresh attempt by reusing the row.
    //
    // dry_run bypasses this entirely — previews are pure and don't mutate.
    idempotencyKey =
      typeof (body as any).idempotency_key === "string" && (body as any).idempotency_key.length > 0
        ? (body as any).idempotency_key
        : null;
    if (!dry_run && idempotencyKey) {
      const { data: existing } = await supabaseAdmin
        .from("payroll_run_jobs")
        .select("id, status, result, payroll_run_id, error_message")
        .eq("organization_id", organization_id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (existing?.status === "succeeded" && existing.result) {
        console.log("[compute-payroll] idempotent replay", { jobId: existing.id, key: idempotencyKey });
        return new Response(JSON.stringify({ ...(existing.result as Record<string, unknown>), idempotent_replay: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (existing?.status === "running" && !isWorkerInvocation) {
        console.log("[compute-payroll] in-flight retry rejected", { jobId: existing.id, key: idempotencyKey });
        // The engine is already executing under this key. The client should
        // observe realtime, not fight the server. Return 202 with the
        // existing jobId so the accept flow is idempotent from the UI's
        // perspective — repeat clicks converge on the same job row.
        return new Response(JSON.stringify({
          accepted: true,
          job_id: existing.id,
          status: "running",
          idempotent_replay: true,
        }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (existing && !isWorkerInvocation) {
        // Prior attempt failed — reuse the row, flip back to running.
        jobId = existing.id;
        await supabaseAdmin
          .from("payroll_run_jobs")
          .update({
            status: "running",
            started_at: new Date().toISOString(),
            accepted_at: new Date().toISOString(),
            heartbeat_at: new Date().toISOString(),
            phase: "queued",
            progress_current: 0,
            progress_total: employee_ids.length,
            cancel_requested_at: null,
            attempt: (existing as any).attempt ? Number((existing as any).attempt) + 1 : 2,
            finished_at: null,
            error_code: null,
            error_message: null,
            result: null,
            payroll_run_id: null,
          })
          .eq("id", jobId);
      } else if (existing && isWorkerInvocation) {
        // Worker invocation for an already-running row — just adopt it.
        jobId = existing.id;
      } else {
        const { data: inserted, error: insertErr } = await supabaseAdmin
          .from("payroll_run_jobs")
          .insert({
            organization_id,
            business_id: business_id ?? null,
            requested_by: userId,
            idempotency_key: idempotencyKey,
            status: "running",
            phase: "queued",
            accepted_at: new Date().toISOString(),
            heartbeat_at: new Date().toISOString(),
            progress_current: 0,
            progress_total: employee_ids.length,
            pay_period_start,
            pay_period_end,
            run_type: body.run_type ?? "regular",
            employee_count: employee_ids.length,
            request_payload: {
              pay_period_start, pay_period_end,
              employee_count: employee_ids.length,
              run_type: body.run_type ?? "regular",
              country_code: country_code ?? null,
              period_id: resolvedPeriodId,
            },
            started_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (insertErr) {
          // 23505 race: another concurrent invoke with the same key won.
          // Re-read and follow the same branch above.
          if (String(insertErr.code) === "23505") {
            const { data: raced } = await supabaseAdmin
              .from("payroll_run_jobs")
              .select("id, status, result")
              .eq("organization_id", organization_id)
              .eq("idempotency_key", idempotencyKey)
              .maybeSingle();
            if (raced?.status === "succeeded" && raced.result) {
              return new Response(JSON.stringify({ ...(raced.result as Record<string, unknown>), idempotent_replay: true }), {
                status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            return new Response(JSON.stringify({
              accepted: true,
              job_id: raced?.id ?? null,
              status: "running",
              idempotent_replay: true,
            }), {
              status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          console.error("[compute-payroll] failed to create job row:", insertErr);
        } else {
          jobId = inserted?.id ?? null;
        }
      }
      console.log("[compute-payroll] job started", { jobId, key: idempotencyKey, employees: employee_ids.length });
    }

    // ─── Accept → fork worker → 202 ────────────────────────────────────
    // Non-worker invocation, real (non-dry) run, and a job row exists:
    // dispatch the worker on a fresh isolate and return 202 to the caller.
    // The browser now subscribes to `payroll_run_jobs` — the HTTP response
    // is no longer the source of truth for whether payroll ran.
    if (!dry_run && jobId && !isWorkerInvocation) {
      const workerUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/compute-payroll`;
      const workerBody = JSON.stringify(body);
      const workerPromise = fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forward the original caller's JWT so downstream auth,
          // entitlement, and permission checks continue to run as that
          // user. If the JWT expires mid-worker the DB sweeper cleans up.
          "Authorization": authHeader,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          "X-Payroll-Worker": "1",
        },
        body: workerBody,
      })
        .then(async (r) => {
          // Drain the body so the connection can close cleanly; the actual
          // outcome lives in `payroll_run_jobs`, not the worker's response.
          try { await r.text(); } catch { /* ignore */ }
          console.log("[compute-payroll] worker dispatched", { jobId, status: r.status });
        })
        .catch((e) => {
          console.error("[compute-payroll] worker dispatch failed", { jobId, err: (e as Error).message });
          // Mark the job failed so the UI stops showing "queued" forever.
          void supabaseAdmin
            .from("payroll_run_jobs")
            .update({
              status: "failed",
              phase: "dispatch_failed",
              finished_at: new Date().toISOString(),
              error_code: "WORKER_DISPATCH_FAILED",
              error_message: "Failed to dispatch payroll worker. Try again.",
            })
            .eq("id", jobId)
            .then(() => {}, () => {});
        });
      try {
        // Keep the isolate alive long enough to hand off the worker request.
        (globalThis as any).EdgeRuntime?.waitUntil?.(workerPromise);
      } catch { /* older runtimes: fetch is dispatched anyway */ }

      return new Response(JSON.stringify({
        accepted: true,
        job_id: jobId,
        status: "queued",
        idempotency_key: idempotencyKey,
      }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Helper: mark job terminal state (best-effort, never throws).
    const finalizeJob = async (
      state: "succeeded" | "failed",
      payload: { result?: unknown; payrollRunId?: string | null; errorCode?: string | null; errorMessage?: string | null },
    ) => {
      if (!jobId) return;
      try {
        // On success, snap the progress bar to 100% so the UI never renders
        // "succeeded · 0 / N employees" just because the loop finished before
        // the last per-employee heartbeat landed. On failure, leave counters
        // in place so operators can see how far the run got.
        let terminalSnap: Record<string, unknown> = {};
        if (state === "succeeded") {
          try {
            const { data: cur } = await supabaseAdmin
              .from("payroll_run_jobs")
              .select("progress_total, employee_count")
              .eq("id", jobId)
              .maybeSingle();
            const total = Number((cur as any)?.progress_total || (cur as any)?.employee_count || 0);
            terminalSnap = { progress_current: total, progress_total: total, phase: "completed" };
          } catch {
            terminalSnap = { phase: "completed" };
          }
        } else {
          terminalSnap = { phase: "failed" };
        }
        await supabaseAdmin
          .from("payroll_run_jobs")
          .update({
            status: state,
            finished_at: new Date().toISOString(),
            result: (payload.result as Record<string, unknown>) ?? null,
            payroll_run_id: payload.payrollRunId ?? null,
            error_code: payload.errorCode ?? null,
            error_message: payload.errorMessage ?? null,
            ...terminalSnap,
          })
          .eq("id", jobId);
      } catch (e) {
        console.error("[compute-payroll] finalizeJob failed:", (e as Error).message);
      }
    };

    // ─── Subscription entitlement check ───
    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const entitlementResult = await checkAppEntitlement(supabaseAdmin, organization_id, "payroll", { requireInstalled: true });
    if (!entitlementResult.allowed) {
      return entitlementDeniedResponse(entitlementResult, corsHeaders);
    }

    // ─── Permission check ───
    const { requireModulePermission } = await import("../_shared/permissionCheck.ts");
    const denied = await requireModulePermission(
      supabaseAdmin, userId, organization_id, "payroll", "create", corsHeaders,
    );
    if (denied) return denied;

    // ─── Payroll readiness check (structured) ───
    // Uses the JSON-returning variant so we can surface per-employee blockers
    // to the UI (PayrollSetupGuideDialog) instead of regex-parsing an English
    // SETUP_REQUIRED exception. Same evaluation engine as the readiness badge —
    // they cannot disagree.
    const { data: readinessPayload, error: readinessError } = await supabaseAdmin.rpc(
      "assert_payroll_ready_json",
      {
        p_org_id: organization_id,
        p_business_id: business_id || null,
        p_employee_ids: employee_ids,
        p_period_start: pay_period_start,
        p_period_end: pay_period_end,
      },
    );
    if (readinessError) {
      return new Response(JSON.stringify({ error: readinessError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (readinessPayload && (readinessPayload as any).is_ready === false) {
      const p = readinessPayload as Record<string, unknown>;
      const blockers = [
        ...((p.org_blockers as unknown[]) || []),
        ...((p.business_blockers as unknown[]) || []),
        ...((p.employee_blockers as unknown[]) || []),
        ...((p.run_blockers as unknown[]) || []),
      ];
      return new Response(JSON.stringify({
        code: "SETUP_REQUIRED",
        error: "Payroll cannot run yet — resolve readiness blockers first.",
        blockers,
        counts: p.counts ?? null,
      }), {
        status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fiscal period lock check ───
    if (!dry_run) {
      const { data: lockedPeriods } = await supabaseAdmin
        .from("fiscal_periods")
        .select("id, name, status")
        .eq("organization_id", organization_id)
        .eq("status", "closed")
        .lte("start_date", pay_period_end)
        .gte("end_date", pay_period_start);

      if (lockedPeriods && lockedPeriods.length > 0) {
        return new Response(JSON.stringify({
          error: `Cannot create payroll: fiscal period "${lockedPeriods[0].name}" is closed. Reopen the period first.`,
        }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Run-type intent + duplicate detection (skip for dry_run) ───
    const runType = (body as PayrollRequest).run_type ?? "regular";
    const parentRunId = (body as PayrollRequest).parent_run_id ?? null;
    const ALLOWED_RUN_TYPES = new Set([
      "regular","off_cycle","supplemental","bonus",
      "commission","13th_month","termination","correction",
    ]);
    if (!ALLOWED_RUN_TYPES.has(runType)) {
      return new Response(JSON.stringify({
        code: "INVALID_RUN_TYPE",
        error: `Unknown run_type '${runType}'.`,
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!dry_run) {
      // Correction / supplemental MUST point at a posted parent run in the same period.
      if (runType === "correction" || runType === "supplemental") {
        if (!parentRunId) {
          return new Response(JSON.stringify({
            code: "PARENT_RUN_REQUIRED",
            error: `${runType} runs require parent_run_id (the posted run being adjusted).`,
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { data: parent } = await supabaseAdmin
          .from("payroll_runs")
          .select("id, status, pay_period_start, pay_period_end, organization_id, business_id")
          .eq("id", parentRunId)
          .maybeSingle();
        if (
          !parent ||
          parent.organization_id !== organization_id ||
          (parent.business_id || null) !== (business_id || null) ||
          parent.pay_period_start !== pay_period_start ||
          parent.pay_period_end !== pay_period_end
        ) {
          return new Response(JSON.stringify({
            code: "PARENT_RUN_MISMATCH",
            error: "parent_run_id does not match the supplied period / business.",
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (!["posted", "paid", "approved"].includes(String(parent.status))) {
          return new Response(JSON.stringify({
            code: "PARENT_RUN_NOT_POSTED",
            error: `Parent run must be posted/approved/paid before a ${runType} run can be created.`,
          }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // Only the REGULAR run is unique per period. Off-cycle / supplemental /
      // bonus / correction may coexist freely (matches Odoo / QuickBooks / Xero).
      if (runType === "regular") {
        const { data: existingRegular } = await supabaseAdmin
          .from("payroll_runs")
          .select("*")
          .eq("organization_id", organization_id)
          .eq("business_id", business_id || null)
          .eq("pay_period_start", pay_period_start)
          .eq("pay_period_end", pay_period_end)
          .eq("run_type", "regular")
          .neq("status", "deleted")
          .maybeSingle();

        if (existingRegular) {
          return new Response(JSON.stringify({
            code: "REGULAR_RUN_EXISTS",
            message: `A regular payroll run already exists for this period (${existingRegular.payroll_number}, status: ${existingRegular.status}).`,
            payroll_run: existingRegular,
            employee_count: existingRegular.employee_count ?? 0,
            warnings: [],
            reused: true,
            existing_run_id: existingRegular.id,
            existing_payroll_number: existingRegular.payroll_number,
            existing_status: existingRegular.status,
            recovery_options: [
              "add_employees_to_existing_run",
              "create_off_cycle_run",
              "create_correction_run",
            ],
          }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // ─── Exit-clearance gate for termination runs ───
    // Enterprise HR systems (SAP SF, Workday) refuse to cut a final payslip
    // until IT/Finance/HR sign off on blocking exit-clearance items
    // (asset return, access revocation, final settlement sign-off).
    // We mirror that here: if runType === 'termination' AND any employee in
    // the request has open (non-cleared) blocking exit-clearance items,
    // refuse the run with a structured 409 listing the blockers.
    if (!dry_run && runType === "termination") {
      const { data: openClearance, error: clearanceErr } = await supabaseAdmin
        .from("employee_exit_clearance")
        .select(
          "id, employee_id, status, employee_exit_clearance_items!inner(id, department, task, status, is_blocking)"
        )
        .eq("organization_id", organization_id)
        .in("employee_id", employee_ids)
        .neq("status", "cleared")
        .eq("employee_exit_clearance_items.is_blocking", true)
        .neq("employee_exit_clearance_items.status", "cleared");

      if (clearanceErr) {
        // Fail closed — never silently allow a termination run when we can't
        // verify clearance state.
        return new Response(JSON.stringify({
          code: "EXIT_CLEARANCE_CHECK_FAILED",
          error: `Could not verify exit clearance: ${clearanceErr.message}`,
        }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (openClearance && openClearance.length > 0) {
        const blockingByEmployee: Record<string, Array<{ department: string; task: string; status: string }>> = {};
        for (const row of openClearance as Array<{
          employee_id: string;
          employee_exit_clearance_items: Array<{ department: string; task: string; status: string; is_blocking: boolean }>;
        }>) {
          const items = (row.employee_exit_clearance_items || [])
            .filter((it) => it.is_blocking && it.status !== "cleared")
            .map((it) => ({ department: it.department, task: it.task, status: it.status }));
          if (items.length === 0) continue;
          const arr = blockingByEmployee[row.employee_id] ?? (blockingByEmployee[row.employee_id] = []);
          arr.push(...items);
        }

        const blockedEmployeeIds = Object.keys(blockingByEmployee);
        if (blockedEmployeeIds.length > 0) {
          return new Response(JSON.stringify({
            code: "EXIT_CLEARANCE_INCOMPLETE",
            error:
              `Cannot compute termination payroll: ${blockedEmployeeIds.length} ` +
              `employee(s) have open blocking exit-clearance items. ` +
              `Complete or waive the items before running the final payslip.`,
            blocked_employee_ids: blockedEmployeeIds,
            blocking_items: blockingByEmployee,
          }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // ─── Phase 3.1 — Resolve run-type behavior policy ───
    // Single source of truth for "what does this run actually do?". Loaded
    // from `payroll_run_type_policies` via the canonical resolver so engine
    // code never branches on the run_type string itself. The resolved policy
    // is also persisted on the payroll_runs row as `run_type_policy_snapshot`
    // for audit / recompute-parity.
    interface RunTypePolicy {
      run_type: string;
      applies_recurring_earnings: boolean;
      applies_recurring_deductions: boolean;
      applies_statutory: boolean;
      applies_loan_installments: boolean;
      applies_garnishments: boolean;
      accrues_leave: boolean;
      accrues_benefits: boolean;
      tax_method: string;
      population_source: string;
      requires_parent_run: boolean;
      country_code: string | null;
    }
    const DEFAULT_RUN_TYPE_POLICY: RunTypePolicy = {
      run_type: runType,
      applies_recurring_earnings: true,
      applies_recurring_deductions: true,
      applies_statutory: true,
      applies_loan_installments: true,
      applies_garnishments: true,
      accrues_leave: true,
      accrues_benefits: true,
      tax_method: "ordinary",
      population_source: "active_in_period",
      requires_parent_run: false,
      country_code: null,
    };
    let runTypePolicy: RunTypePolicy = DEFAULT_RUN_TYPE_POLICY;
    {
      const { data: policyJson, error: policyErr } = await supabaseAdmin.rpc(
        "payroll_get_run_type_policy",
        { p_country_code: country_code ?? null, p_run_type: runType },
      );
      if (policyErr) {
        // Fail closed for non-regular runs — silent behavior drift on a
        // bonus/termination/correction run is a payroll-accuracy incident.
        if (runType !== "regular") {
          return new Response(JSON.stringify({
            code: "RUN_TYPE_POLICY_RESOLUTION_FAILED",
            error: `Could not resolve run-type policy for '${runType}': ${policyErr.message}`,
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } else if (policyJson && typeof policyJson === "object") {
        runTypePolicy = { ...DEFAULT_RUN_TYPE_POLICY, ...(policyJson as Record<string, unknown>) } as RunTypePolicy;
      }
    }

    // ─── Phase 3.2 — Server-authoritative population resolution ───
    // The engine NEVER trusts the caller-supplied `employee_ids` as the
    // final set. Every payroll run resolves its population via the single
    // source of truth `payroll_resolve_run_population`, which honors the
    // run-type policy's `population_source` (active_in_period /
    // terminating_in_period / parent_run / explicit) and applies the
    // cross-cutting "already in an open run of the same type" gate.
    //
    // Behavior:
    //   • The caller's `employee_ids` is treated as INTENT (a hint).
    //   • The resolver decides who is actually eligible.
    //   • Any caller-supplied employee the resolver excluded is reported
    //     back as a structured 409 — we refuse to silently drop people.
    //   • Skipped on dry_run so the UI preview can still surface blockers
    //     without failing.
    {
      const { data: resolved, error: resolveErr } = await supabaseAdmin.rpc(
        "payroll_resolve_run_population",
        {
          p_org_id: organization_id,
          p_business_id: business_id || null,
          p_period_start: pay_period_start,
          p_period_end: pay_period_end,
          p_run_type: runType,
          p_country_code: country_code ?? null,
          p_parent_run_id: parentRunId,
          p_explicit_employee_ids: employee_ids,
        },
      );
      if (resolveErr) {
        return new Response(JSON.stringify({
          code: "POPULATION_RESOLVE_FAILED",
          error: `Could not resolve run population: ${resolveErr.message}`,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const resolvedRows = (resolved ?? []) as Array<{
        employee_id: string;
        included: boolean;
        inclusion_reason: string;
        blockers: Record<string, unknown> | null;
      }>;
      const includedSet = new Set(resolvedRows.filter((r) => r.included).map((r) => r.employee_id));
      const blockerMap: Record<string, Record<string, unknown>> = {};
      for (const r of resolvedRows) {
        if (!r.included && r.blockers) blockerMap[r.employee_id] = r.blockers;
      }

      if (!dry_run) {
        const rejected = employee_ids.filter((id: string) => !includedSet.has(id));
        if (rejected.length > 0) {
          return new Response(JSON.stringify({
            code: "POPULATION_REJECTED",
            error:
              `${rejected.length} requested employee(s) are not eligible for this ${runType} run. ` +
              `Resolve the blockers or remove them from the selection.`,
            rejected_employee_ids: rejected,
            blockers: rejected.reduce((acc, id) => {
              acc[id] = blockerMap[id] ?? { UNKNOWN: { message: "Not in resolved population." } };
              return acc;
            }, {} as Record<string, unknown>),
          }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } else {
        // Dry run: keep going, but narrow the working set to what the
        // resolver actually approves so the preview reflects reality.
        const narrowed = employee_ids.filter((id: string) => includedSet.has(id));
        if (narrowed.length === 0) {
          return new Response(JSON.stringify({
            code: "POPULATION_EMPTY",
            error: "No requested employees are eligible for this run.",
            blockers: blockerMap,
          }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // mutate the destructured array reference in-place
        employee_ids.length = 0;
        Array.prototype.push.apply(employee_ids, narrowed);
      }
    }


    // ─── Fetch payroll settings + country (consolidated via v_payroll_settings_effective) ───
    // The view returns one effective row per business, preferring payroll_settings.* over the
    // deprecated businesses.payroll_standard_* columns and falling back to platform defaults.
    let payrollSettings: PayrollSettings = { ...DEFAULT_PAYROLL_SETTINGS };
    let bizRow: { country?: string | null } | null = null;
    if (business_id) {
      const { data } = await supabaseAdmin
        .from("v_payroll_settings_effective")
        .select("standard_working_days, standard_hours_per_day, overtime_multiplier, country")
        .eq("business_id", business_id)
        .maybeSingle();
      bizRow = (data as any) || null;
      if (bizRow) {
        const wd = Number((bizRow as any).standard_working_days);
        const hpd = Number((bizRow as any).standard_hours_per_day);
        const otm = Number((bizRow as any).overtime_multiplier);
        if (!isNaN(wd) && wd > 0) payrollSettings.standard_working_days = wd;
        if (!isNaN(hpd) && hpd > 0) payrollSettings.standard_hours_per_day = hpd;
        if (!isNaN(otm) && otm > 0) payrollSettings.overtime_multiplier = otm;
      }
    }


    // ─── Fetch employees ───
    // Phase 4: `statutory_country_code` lets a single payroll run mix
    // employees across jurisdictions. Falls back to the run-level
    // `country_code` payload or business.country (already loaded).
    const { data: employees, error: empError } = await supabaseAdmin
      .from("employees")
      .select("id, user_id, other_allowances, first_name, last_name, employee_number, is_active, hire_date, termination_date, statutory_country_code, business_id")
      .eq("organization_id", organization_id)
      .in("id", employee_ids)
      .eq("is_active", true);


    if (empError) throw empError;
    if (!employees || employees.length === 0) {
      return new Response(JSON.stringify({ error: "No active employees found for the given IDs" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    phase("employees-loaded", { count: employees.length });
    await heartbeat("running", { current: 0, total: employees.length });

    // ─── Fetch profile names for display ───
    const userIds = employees.filter(e => e.user_id).map(e => e.user_id);
    const profileNameMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", userIds);
      if (profiles) {
        for (const p of profiles) {
          if (p.full_name?.trim()) profileNameMap[p.user_id] = p.full_name.trim();
        }
      }
    }

    // ─── Fetch active contracts for employees ───
    const { data: activeContracts } = await supabaseAdmin
      .from("employee_contracts")
      .select("id, employee_id, wage, housing_allowance, transport_allowance, other_allowances, working_schedule, salary_structure_id, compensation_mode, time_tracking_source, start_date, end_date")
      .eq("organization_id", organization_id)
      .in("employee_id", employee_ids)
      .in("status", ["running", "new"])
      .lte("start_date", pay_period_end)
      .or(`end_date.is.null,end_date.gte.${pay_period_start}`);

    const contractByEmployee: Record<string, any> = {};
    for (const contract of (activeContracts || [])) {
      if (!contractByEmployee[contract.employee_id]) {
        contractByEmployee[contract.employee_id] = contract;
      }
    }

    // ─── Pre-tax statutory inputs sourced from contract components ───
    // insurance_premium was the original single case (Wave 1.1); the audit
    // 2026-07-05 closeout expanded this to every pre-tax token referenced by
    // shipped packs (ahr_contribution, mortgage_interest, pension_contribution,
    // post_retirement_medical). One query, then per-token aggregation, so
    // adding future tokens is a data change — no engine patch. Country-agnostic:
    // the engine never mentions KE/UG/TZ, only component_codes.
    const PRETAX_COMPONENT_CODES = [
      "insurance_premium",
      "ahr_contribution",
      "mortgage_interest",
      "pension_contribution",
      "post_retirement_medical",
    ] as const;
    const activeContractIds = Object.values(contractByEmployee)
      .map((c: any) => c.id)
      .filter(Boolean);
    const preTaxByEmpAndCode: Record<string, Record<string, number>> = {};
    if (activeContractIds.length > 0) {
      const { data: ptComponents } = await supabaseAdmin
        .from("contract_compensation_components")
        .select("contract_id, component_code, amount, effective_from, effective_to")
        .in("contract_id", activeContractIds)
        .in("component_code", PRETAX_COMPONENT_CODES as unknown as string[])
        .or(`effective_from.is.null,effective_from.lte.${pay_period_end}`)
        .or(`effective_to.is.null,effective_to.gte.${pay_period_start}`);
      const sumByContractAndCode: Record<string, Record<string, number>> = {};
      for (const c of (ptComponents || []) as any[]) {
        const bucket = (sumByContractAndCode[c.contract_id] ||= {});
        bucket[c.component_code] = (bucket[c.component_code] || 0) + Number(c.amount || 0);
      }
      for (const [empId, contract] of Object.entries(contractByEmployee)) {
        const bucket = sumByContractAndCode[(contract as any).id] || {};
        preTaxByEmpAndCode[empId] = bucket;
      }
    }
    // Disability certification is stored in employee_statutory_identifiers
    // (see ADR 0036 — pack-driven identifier registry). Presence of an
    // active `disability_certified` row is the truthy gate for the KE
    // pack's disability_exemption relief.
    const disabilityCertifiedEmpIds = new Set<string>();
    const empIds = (employees as any[]).map((e) => e.id).filter(Boolean);
    if (empIds.length > 0) {
      const { data: idRows } = await supabaseAdmin
        .from("employee_statutory_identifiers")
        .select("employee_id, identifier_type, is_active")
        .in("employee_id", empIds)
        .eq("identifier_type", "disability_certified")
        .eq("is_active", true);
      for (const r of (idRows || []) as any[]) {
        if (r.employee_id) disabilityCertifiedEmpIds.add(r.employee_id);
      }
    }
    for (const emp of employees as any[]) {
      const bucket = preTaxByEmpAndCode[emp.id] || {};
      (emp as any).insurance_premium = bucket.insurance_premium || 0;
      (emp as any).ahr_contribution = bucket.ahr_contribution || 0;
      (emp as any).mortgage_interest = bucket.mortgage_interest || 0;
      (emp as any).pension_contribution = bucket.pension_contribution || 0;
      (emp as any).post_retirement_medical = bucket.post_retirement_medical || 0;
      (emp as any).disability_certified = disabilityCertifiedEmpIds.has(emp.id);
    }

    // ─── Stage 7 engine gate: timesheet-driven contracts require approval ───
    // For employees whose active contract uses time_tracking_source='timesheets'
    // we refuse to compute payroll unless EVERY timesheet row in the pay period
    // is status='approved'. Anything else (draft/submitted/rejected) means the
    // numbers aren't trustworthy and the engine MUST surface a blocker rather
    // than silently treating those hours as zero (or worse, including them).
    const skippedEmployees: Map<string, { code: string; message: string; details?: Record<string, unknown> }> = new Map();
    const tsGateEmpIds = Object.entries(contractByEmployee)
      .filter(([, c]: [string, any]) => c?.time_tracking_source === "timesheets")
      .map(([empId]) => empId);
    if (tsGateEmpIds.length > 0) {
      const { data: periodTimesheets } = await supabaseAdmin
        .from("timesheets")
        .select("employee_id, status")
        .eq("organization_id", organization_id)
        .in("employee_id", tsGateEmpIds)
        .gte("date", pay_period_start)
        .lte("date", pay_period_end);
      const badByEmp: Record<string, Record<string, number>> = {};
      const hasAnyByEmp: Record<string, boolean> = {};
      for (const row of (periodTimesheets || []) as any[]) {
        hasAnyByEmp[row.employee_id] = true;
        if (row.status !== "approved") {
          badByEmp[row.employee_id] = badByEmp[row.employee_id] || {};
          badByEmp[row.employee_id][row.status || "unknown"] =
            (badByEmp[row.employee_id][row.status || "unknown"] || 0) + 1;
        }
      }
      for (const empId of tsGateEmpIds) {
        if (!hasAnyByEmp[empId]) {
          skippedEmployees.set(empId, {
            code: "TIMESHEETS_MISSING",
            message: "Contract requires timesheets but no timesheet rows exist for this pay period.",
          });
        } else if (badByEmp[empId]) {
          const breakdown = Object.entries(badByEmp[empId])
            .map(([s, n]) => `${n} ${s}`)
            .join(", ");
          skippedEmployees.set(empId, {
            code: "TIMESHEETS_NOT_APPROVED",
            message: `Timesheets in pay period are not all approved (${breakdown}). Approve them before running payroll.`,
            details: { non_approved: badByEmp[empId] },
          });
        }
      }
    }

    // ─── R3: Resolve immutable salary structure rule sets ───
    // We NEVER read live `salary_components` at compute time — payroll must be
    // byte-identical on recompute even after admins edit the structure later.
    // `resolve_or_publish_rule_set` returns the rule set in effect at
    // pay_period_end and auto-publishes v1 transparently for legacy structures.
    const structureIds = [...new Set(
      (activeContracts || [])
        .map((c: any) => c.salary_structure_id)
        .filter(Boolean)
    )];

    const componentsByStructure: Record<string, any[]> = {};
    const ruleSetByStructure: Record<string, { id: string; version: number; rule_hash: string }> = {};
    // ─── Phase 3 — Rule-graph engine wiring ───
    // When a structure has `use_structure_engine=true` AND at least one
    // `payroll_salary_rules` row, the per-employee salary resolution swaps
    // the legacy two-pass component walk for `runStructureEngine`. Legacy
    // structures are unaffected (flag defaults to false; walk still runs).
    // NOTE ON HISTORICAL RECOMPUTE: graph rules are read live here, so
    // structures whose rules are edited after the run WILL diverge on
    // recompute. Snapshotting graph rules into `salary_structure_rule_sets`
    // is tracked as follow-up; the flat-component path continues to be
    // byte-identical via the existing rule-set snapshot.
    const structureUsesEngine: Record<string, boolean> = {};
    const structureRulesByStructure: Record<string, SalaryRule[]> = {};
    for (const sid of structureIds) {
      const { data: rs, error: rsErr } = await supabaseAdmin.rpc("resolve_or_publish_rule_set", {
        p_structure_id: sid,
        p_as_of: pay_period_end,
      });
      if (rsErr) {
        console.warn(`[compute-payroll] resolve_or_publish_rule_set failed for ${sid}: ${rsErr.message}`);
        continue;
      }
      const row = Array.isArray(rs) ? rs[0] : rs;
      if (!row || !row.rule_set_id) continue;
      ruleSetByStructure[sid] = {
        id: row.rule_set_id,
        version: row.version,
        rule_hash: row.rule_hash,
      };
      const comps = (row.components || []) as any[];
      componentsByStructure[sid] = comps
        .map((c: any) => ({ ...c, structure_id: sid }))
        .sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));
    }

    // Pull the engine flag + live rule graph in one pass.
    if (structureIds.length > 0) {
      const { data: structRows } = await supabaseAdmin
        .from("salary_structures")
        .select("id, use_structure_engine")
        .in("id", structureIds);
      for (const s of (structRows || []) as any[]) {
        structureUsesEngine[s.id] = Boolean(s.use_structure_engine);
      }
      const graphIds = structureIds.filter((sid) => structureUsesEngine[sid]);
      if (graphIds.length > 0) {
        const { data: graphRows } = await supabaseAdmin
          .from("payroll_salary_rules")
          .select("*")
          .in("structure_id", graphIds)
          .eq("is_active", true)
          .order("sequence", { ascending: true });
        for (const r of (graphRows || []) as any[]) {
          const rule: SalaryRule = {
            id: r.id,
            code: r.code,
            name: r.name,
            sequence: r.sequence,
            category: r.category,
            parent_rule_id: r.parent_rule_id,
            condition_select: r.condition_select,
            condition_expression: r.condition_expression,
            amount_select: r.amount_select,
            amount_fixed: r.amount_fixed,
            amount_percentage: r.amount_percentage,
            amount_base: r.amount_base,
            amount_expression: r.amount_expression,
            statutory_rule_id: r.statutory_rule_id,
            appears_on_payslip: r.appears_on_payslip ?? true,
            accounting_debit_account_id: r.accounting_debit_account_id,
            accounting_credit_account_id: r.accounting_credit_account_id,
            accounting_tag: r.accounting_tag,
            is_active: r.is_active ?? true,
          };
          (structureRulesByStructure[r.structure_id] ||= []).push(rule);
        }
      }
    }

    // Work entry types (needed by runStructureEngine for hours→pay derivation).
    // Cheap read; scoped to the org so unrelated tenant rows are excluded.
    const workEntryTypes: WorkEntryType[] = [];
    {
      const { data: wetRows } = await supabaseAdmin
        .from("payroll_work_entry_types")
        .select("id, code, is_paid, counts_as_worked, multiplier_normal, multiplier_overtime, accounting_tag")
        .eq("organization_id", organization_id)
        .eq("is_active", true);
      for (const t of (wetRows || []) as any[]) {
        workEntryTypes.push({
          id: t.id,
          code: t.code,
          is_paid: t.is_paid,
          counts_as_worked: t.counts_as_worked,
          multiplier_normal: Number(t.multiplier_normal ?? 1),
          multiplier_overtime: Number(t.multiplier_overtime ?? 1.5),
          accounting_tag: t.accounting_tag ?? null,
        });
      }
    }

    // Work entries for the period, grouped by employee. Feeds runStructureEngine
    // via its `worked_hours` / `worked_days` derivations. When no rows exist
    // for an employee the engine still runs — entries are optional.
    const workEntriesByEmployee: Record<string, any[]> = {};
    if (employee_ids.length > 0) {
      const { data: weRows } = await supabaseAdmin
        .from("payroll_work_entries")
        .select("employee_id, work_entry_type_id, hours, overtime_hours, days")
        .eq("organization_id", organization_id)
        .in("employee_id", employee_ids)
        .gte("date", pay_period_start)
        .lte("date", pay_period_end);
      for (const r of (weRows || []) as any[]) {
        (workEntriesByEmployee[r.employee_id] ||= []).push(r);
      }
    }


    // ─── Fetch active benefit enrollments + plans ───
    const { data: benefitEnrollments } = await supabaseAdmin
      .from("employee_benefits")
      .select("employee_id, benefit_plan_id, status")
      .eq("organization_id", organization_id)
      .in("employee_id", employee_ids)
      .eq("status", "active");

    const enrolledPlanIds = [...new Set(
      (benefitEnrollments || []).map((e: any) => e.benefit_plan_id)
    )];

    const benefitPlansById: Record<string, any> = {};
    if (enrolledPlanIds.length > 0) {
      const { data: plans } = await supabaseAdmin
        .from("benefit_plans")
        .select("*")
        .in("id", enrolledPlanIds)
        .eq("is_active", true);

      for (const plan of (plans || [])) {
        benefitPlansById[plan.id] = plan;
      }
    }

    const benefitsByEmployee: Record<string, any[]> = {};
    for (const enrollment of (benefitEnrollments || [])) {
      const plan = benefitPlansById[enrollment.benefit_plan_id];
      if (!plan) continue;
      if (!benefitsByEmployee[enrollment.employee_id]) benefitsByEmployee[enrollment.employee_id] = [];
      benefitsByEmployee[enrollment.employee_id].push(plan);
    }

    // ─── Fetch statutory rules per jurisdiction (Phase 4 multi-jurisdiction) ───
    // A single run can mix employees across countries via
    // `employees.statutory_country_code`. Collect every country in the run
    // and load all rule rows for them in one query, indexed by upper-cased
    // country code. The legacy single-country fast path is preserved via
    // the `statutoryRules` alias below.
    const todayIso = new Date().toISOString().split("T")[0];
    const bizDefaultCountry =
      (bizRow as any)?.country
        ? String((bizRow as any).country).toUpperCase()
        : null;

    function resolveEmployeeCountry(emp: any): string | null {
      const c =
        emp?.statutory_country_code ||
        country_code ||
        bizDefaultCountry;
      return c ? String(c).toUpperCase() : null;
    }

    const countriesInRun = new Set<string>();
    for (const e of employees) {
      const c = resolveEmployeeCountry(e);
      if (c) countriesInRun.add(c);
    }

    const rulesByCountry: Record<string, PayrollRule[]> = {};

    // R1/R5/R6: per-run sink for rule-configuration issues detected outside the
    // engine dispatch (standalone relief rules, malformed bracket rules,
    // housing-exemption traces). Declared up here because rule-loading below
    // pushes into it; the original declaration on ~L1377 was a use-before-decl
    // bug that broke `deno test`/typecheck.
    const ruleConfigIssues: Array<{
      employee_id: string | null;
      code: string;
      severity: "info" | "warning" | "blocker";
      message: string;
      details: Record<string, unknown>;
    }> = [];

    if (countriesInRun.size > 0) {
      // RESOLVER-EXEMPT: engine-wide bulk load of active statutory rules per country/period.
      // The shared resolver's row-at-a-time API would issue O(rules) round-trips inside the
      // per-employee loop. Tracked as P2.a in ADR-0056 (dependency graph will let us swap this
      // for a resolver-batched call without regressing latency).
      const { data: rules } = await supabaseAdmin
        .from("payroll_statutory_rules")
        .select("id, rule_type, rule_name, rule_code, parameters, sort_order, computation_method, country_code, superseded_by, effective_to, pack_version_id")
        .eq("organization_id", organization_id)
        .in("country_code", Array.from(countriesInRun))
        .eq("is_active", true)
        .lte("effective_from", todayIso)
        .or(`effective_to.is.null,effective_to.gte.${todayIso}`)
        .order("sort_order", { ascending: true });

      // Phase 5: skip rules that have been formally superseded by a successor
      // whose effective_to is in the past (the engine treats superseded_by as
      // the canonical replacement marker, replacing the legacy
      // `parameters.status='replaced_by_shif'` sentinel).
      const filteredRules = (rules || []).filter((r: any) => {
        if (!r.superseded_by) return true;
        if (!r.effective_to) return true;
        return new Date(r.effective_to) >= new Date(todayIso);
      });

      // Country-specific `rule_type` sentinels are no longer accepted.
      // The engine is country-agnostic; behaviors that were previously
      // expressed as `rule_type='housing_exemption' | 'personal_relief' |
      // 'insurance_relief'` must now live inside the PAYE rule's
      // `parameters` (taxable_income_adjustments[], personal_relief,
      // insurance_relief_rate, insurance_relief_max). See .lovable/plan.md
      // Phase 3 step 10. Packs that still ship these sentinels surface a
      // blocker and are skipped.
      // All three historical country-specific sentinels are now blockers.
      // Packs MUST express these via the PAYE rule's `parameters`:
      //   - housing relief  -> parameters.taxable_income_adjustments[]
      //   - personal relief -> parameters.personal_relief
      //   - insurance relief-> parameters.insurance_relief_rate / _max
      const DEPRECATED_SENTINEL_RULE_TYPES = new Set([
        "housing_exemption",
        "personal_relief",
        "insurance_relief",
      ]);

      for (const rule of filteredRules) {
        const cc = String((rule as any).country_code || "").toUpperCase();
        if (!cc) continue;
        if (DEPRECATED_SENTINEL_RULE_TYPES.has(String(rule.rule_type))) {
          ruleConfigIssues.push({
            employee_id: null,
            code: "DEPRECATED_SENTINEL_RULE_TYPE",
            severity: "blocker",
            message:
              `Statutory rule "${rule.rule_name}" uses the removed rule_type='${rule.rule_type}' sentinel. ` +
              `Move the value into the PAYE rule's parameters ` +
              `(taxable_income_adjustments[] for housing, ` +
              `personal_relief / insurance_relief_rate / insurance_relief_max for reliefs) ` +
              `and delete this standalone rule.`,
            details: { rule_id: rule.id, rule_type: rule.rule_type, country_code: cc, rule_code: rule.rule_code },
          });
          continue;
        }
        // R5: a bracket_progressive rule without a non-empty `brackets[]` array
        // silently evaluates to zero. Detect once per run and emit a blocker so
        // the misconfiguration cannot hide behind a zero-PAYE payslip.
        {
          const cm = (rule.computation_method || "").toLowerCase();
          const brk = (rule.parameters as any)?.brackets;
          if (cm === "bracket_progressive" && (!Array.isArray(brk) || brk.length === 0)) {
            ruleConfigIssues.push({
              employee_id: null,
              code: "BRACKET_PROGRESSIVE_MISSING_BRACKETS",
              severity: "blocker",
              message:
                `Statutory rule "${rule.rule_name}" uses computation_method='bracket_progressive' ` +
                `but parameters.brackets is missing or empty. The rule will produce zero tax for every ` +
                `employee until brackets are configured.`,
              details: { rule_id: rule.id, rule_type: rule.rule_type, country_code: cc, rule_code: rule.rule_code },
            });
          }
        }
        if (!rulesByCountry[cc]) rulesByCountry[cc] = [];
        rulesByCountry[cc].push(rule as PayrollRule);
      }
    }

    // Generic taxable-income adjustments declared on ANY active rule.
    function computeTaxableIncomeAdjustments(
      rulesIn: PayrollRule[],
      empHousingAllowance: number,
    ): { housingExempt: number } {
      // Housing exemption (and any future taxable-income adjustment) is
      // declared inside the PAYE rule's `parameters.taxable_income_adjustments[]`.
      // The country-specific `rule_type='housing_exemption'` sentinel was
      // removed — see Phase 3 step 10 in .lovable/plan.md.
      let housingCap = 0;
      for (const rule of rulesIn) {
        const adjustments = (rule.parameters as any)?.taxable_income_adjustments;
        if (!Array.isArray(adjustments)) continue;
        for (const adj of adjustments) {
          if (adj?.source === "housing_allowance" && adj?.method === "cap_exempt") {
            housingCap = Math.max(housingCap, Number(adj.max_amount ?? 0));
          }
        }
      }
      return { housingExempt: Math.min(empHousingAllowance, housingCap) };
    }

    // ─── Statutory scheme components lookup (Phase: Statutory Scheme model) ───
    // Load all active scheme components for the countries in this run and
    // build a Map keyed by `${country}:${rule_code}:${party}` → component id.
    // Stamped onto payslip_lines.scheme_component_id at emit time so return
    // generators can aggregate by component (structural) rather than by
    // rule_code string convention. Country-agnostic — packs for KE, UG, TZ,
    // NG, etc. all populate the same tables and get the same behaviour.
    const schemeComponentByKey = new Map<string, string>();
    try {
      const { data: schemeComponents } = await supabaseAdmin
        .from("statutory_scheme_components")
        .select("id, rule_code, party, is_active, statutory_schemes!inner(country_code, is_active)")
        .eq("is_active", true)
        .in("statutory_schemes.country_code", Array.from(countriesInRun));
      for (const c of (schemeComponents || []) as any[]) {
        const cc = String(c.statutory_schemes?.country_code || "").toUpperCase();
        if (!cc) continue;
        schemeComponentByKey.set(`${cc}:${c.rule_code}:${c.party}`, c.id);
      }
    } catch (e) {
      console.warn("[compute-payroll] statutory_scheme_components load failed (non-fatal):", (e as Error).message);
    }
    const resolveSchemeComponentId = (
      countryCode: string | null | undefined,
      ruleCode: string | null | undefined,
      employeeAmount: number,
      employerAmount: number,
    ): string | null => {
      if (!countryCode || !ruleCode) return null;
      const cc = String(countryCode).toUpperCase();
      // Prefer employee party when employee_amount > 0, else employer.
      // If both are non-zero (rare), employee wins — the deduction line is
      // the primary regulator surface; the employer contribution has its
      // own separate line via the employer emitter.
      if (employeeAmount > 0) {
        const hit = schemeComponentByKey.get(`${cc}:${ruleCode}:employee`);
        if (hit) return hit;
      }
      if (employerAmount > 0) {
        const hit = schemeComponentByKey.get(`${cc}:${ruleCode}:employer`);
        if (hit) return hit;
      }
      return null;
    };


    // Legacy alias for the single-country fast path. When the caller
    // passed a top-level `country_code`, this points at that slice.
    const statutoryRules: PayrollRule[] = country_code
      ? (rulesByCountry[String(country_code).toUpperCase()] || [])
      : [];

    const hasRules =
      statutoryRules.length > 0 || Object.keys(rulesByCountry).length > 0;
    // Lookup by rule_name across ALL countries — payslip-line emitter just
    // needs to know if a name came from the statutory engine.
    const statutoryRuleByName: Record<string, PayrollRule> = Object.fromEntries(
      Object.values(rulesByCountry).flat().map((r) => [r.rule_name, r]),
    );



    // ─── Fetch active loans (with loan_type for dynamic repayment behavior) ───
    const { data: activeLoans } = await supabaseAdmin
      .from("employee_loans")
      .select(`
        id, employee_id, loan_number, outstanding_balance,
        monthly_deduction, repayment_method, repayment_percent,
        min_net_pay_floor, max_pct_of_net, paused_until, status,
        loan_type_id,
        loan_types ( code, salary_rule_code, requires_schedule, deduction_priority )
      `)
      .eq("organization_id", organization_id)
      .eq("status", "active")
      .in("employee_id", employee_ids);

    // Pull the next pending installment per loan (for fixed_installment loans)
    const loanIds = (activeLoans || []).map((l: any) => l.id);
    const nextInstallmentByLoan: Record<string, { id: string; scheduled_amount: number; paid_amount: number }> = {};
    if (loanIds.length > 0) {
      const { data: schedRows } = await supabaseAdmin
        .from("loan_repayment_schedule")
        .select("id, loan_id, sequence, scheduled_amount, paid_amount, status")
        .in("loan_id", loanIds)
        .in("status", ["pending", "partial"])
        .order("sequence", { ascending: true });
      for (const r of (schedRows || []) as any[]) {
        if (!nextInstallmentByLoan[r.loan_id]) {
          nextInstallmentByLoan[r.loan_id] = {
            id: r.id,
            scheduled_amount: Number(r.scheduled_amount || 0),
            paid_amount: Number(r.paid_amount || 0),
          };
        }
      }
    }

    // ─── Load approved loan skip overrides for this run ───
    // The engine MUST honour `approved` overrides:
    //   * fixed_installment loans → skip the specific scheduled installment id
    //   * other methods → skip all loan deduction for the run
    // After we consume an override we mark it 'consumed' and apply the
    // loan-type's schedule adjustment so the loan amortisation stays sound.
    const skippedScheduleIds = new Set<string>();
    const skippedLoanIds = new Set<string>();
    const overridesByScheduleId: Record<string, { id: string; loan_id: string; schedule_id: string; employee_id: string }> = {};
    const overridesByLoanIdForRun: Record<string, { id: string; loan_id: string; schedule_id: string; employee_id: string }> = {};
    {
      // Resolve the open run for this org/business/period to read overrides from.
      const { data: openRunRow } = await supabaseAdmin
        .from("payroll_runs")
        .select("id")
        .eq("organization_id", organization_id)
        .eq("business_id", business_id || null)
        .eq("pay_period_start", pay_period_start)
        .eq("pay_period_end", pay_period_end)
        .in("status", ["draft", "computing", "computed", "processing"])
        .maybeSingle();
      if (openRunRow?.id) {
        const { data: approvedOverrides } = await supabaseAdmin
          .from("payroll_run_loan_skip_overrides")
          .select("id, loan_id, schedule_id, employee_id")
          .eq("payroll_run_id", openRunRow.id)
          .eq("status", "approved");
        for (const ov of (approvedOverrides || []) as any[]) {
          skippedScheduleIds.add(ov.schedule_id);
          skippedLoanIds.add(ov.loan_id);
          overridesByScheduleId[ov.schedule_id] = ov;
          overridesByLoanIdForRun[ov.loan_id] = ov;
        }
      }
    }

    const loansByEmployee: Record<string, any[]> = {};
    for (const loan of (activeLoans || [])) {
      // Skip paused loans whose pause has not yet expired
      if (loan.paused_until && new Date(loan.paused_until) >= new Date(pay_period_end)) continue;
      if (!loansByEmployee[loan.employee_id]) loansByEmployee[loan.employee_id] = [];
      loansByEmployee[loan.employee_id].push(loan);
    }
    // Order each employee's loans by loan_type.deduction_priority (ascending;
    // lower number = higher priority). Ties fall back to loan creation order
    // (implicit — array is already in fetch order which is stable per PG).
    // Phase C: policy-driven ordering replaces the previous fetch-order default.
    for (const empId of Object.keys(loansByEmployee)) {
      loansByEmployee[empId].sort((a: any, b: any) => {
        const pa = Number(a.loan_types?.deduction_priority ?? 1000);
        const pb = Number(b.loan_types?.deduction_priority ?? 1000);
        return pa - pb;
      });
    }

    // Strip skipped installments from the next-installment map so
    // fixed_installment loans naturally fall to "nothing due" for this run.
    for (const sid of skippedScheduleIds) {
      for (const loanId of Object.keys(nextInstallmentByLoan)) {
        if (nextInstallmentByLoan[loanId].id === sid) {
          delete nextInstallmentByLoan[loanId];
        }
      }
    }

    // ─── Fetch active employee advances (recoverable in this run) ───
    // First-class concept (employee_advances + advance_repayment_schedule).
    // Advances are recovered after loans but before garnishments, applying
    // the same min-net-pay floor discipline used for loans.
    const { data: activeAdvances } = await supabaseAdmin
      .from("employee_advances")
      .select("id, employee_id, amount, recovered_amount, recovery_method, installment_count, installment_amount, min_net_floor, status, currency, advance_date")
      .eq("organization_id", organization_id)
      .in("status", ["approved", "disbursed", "recovering"])
      .in("employee_id", employee_ids);

    const advancesByEmployee: Record<string, any[]> = {};
    for (const adv of (activeAdvances || [])) {
      const outstanding = Number(adv.amount || 0) - Number(adv.recovered_amount || 0);
      if (outstanding <= 0) continue;
      if (!advancesByEmployee[adv.employee_id]) advancesByEmployee[adv.employee_id] = [];
      advancesByEmployee[adv.employee_id].push({ ...adv, outstanding });
    }
    const advanceRecoveriesToRecord: Array<{
      advance_id: string;
      employee_id: string;
      amount: number;
      payslip_id?: string | null;
      payroll_run_id?: string | null;
    }> = [];

    // ─── Fetch active custom deduction assignments (Slice 2) ───
    // Workspace-defined ad-hoc deductions. Applied after loans/advances/
    // garnishments and reimbursements. Post-tax only in this pass — pre_tax
    // types are rejected loudly below (would require reordering the PAYE
    // calculation, tracked as a follow-up).
    const customDeductionsByEmployee: Record<string, any[]> = {};
    const customDeductionsApplied: Array<{
      assignment_id: string;
      employee_id: string;
      amount: number;
      type_id: string;
    }> = [];
    if (business_id) {
      const { data: cdAssignments, error: cdErr } = await supabaseAdmin
        .from("employee_custom_deductions")
        .select("*, deduction_type:custom_deduction_types(*)")
        .eq("business_id", business_id)
        .in("status", ["approved", "active"])
        .in("employee_id", employee_ids)
        .lte("effective_from", pay_period_end)
        .or(`effective_to.is.null,effective_to.gte.${pay_period_start}`);
      if (cdErr) {
        console.warn("[compute-payroll] custom deductions fetch failed:", cdErr.message);
      }
      for (const a of (cdAssignments || [])) {
        (customDeductionsByEmployee[a.employee_id] ||= []).push(a);
      }
    }



    // ─── Guard: refuse to compute while corrections are pending ───
    {
      const { data: pendingCount, error: pendingErr } = await supabaseAdmin.rpc(
        "attendance_pending_corrections_count",
        {
          _organization_id: organization_id,
          _from: pay_period_start,
          _to: pay_period_end,
          _employee_ids: employee_ids,
        },
      );
      if (!pendingErr && (pendingCount ?? 0) > 0) {
        const { data: sample } = await supabaseAdmin
          .from("attendance")
          .select("id, employee_id, attendance_date")
          .eq("organization_id", organization_id)
          .in("employee_id", employee_ids)
          .gte("attendance_date", pay_period_start)
          .lte("attendance_date", pay_period_end)
          .eq("correction_status", "pending")
          .limit(5);
        return new Response(
          JSON.stringify({
            error: "pending_corrections",
            message: `Cannot compute payroll: ${pendingCount} attendance correction(s) are pending review. Resolve them first.`,
            pending_count: pendingCount,
            sample,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ─── Fetch attendance records for the pay period ───
    // Wave 4: when attendance_settings.require_approval_for_payroll is on,
    // only count rows that have been explicitly approved (approved_by IS NOT NULL).
    // Phase 2/3: when attendance_settings.require_ot_preapproval is on, cap each
    // employee's overtime hours at the sum of their approved overtime_requests
    // for the pay period — unapproved OT is excluded from payroll and flagged.
    let requireApproval = false;
    let requireOtPreapproval = false;
    {
      const { data: attSettings } = await supabaseAdmin
        .from("attendance_settings")
        .select("require_approval_for_payroll, require_ot_preapproval")
        .eq("organization_id", organization_id)
        .maybeSingle();
      requireApproval = !!attSettings?.require_approval_for_payroll;
      requireOtPreapproval = !!(attSettings as any)?.require_ot_preapproval;
    }
    let attendanceQuery = supabaseAdmin
      .from("attendance")
      .select("id, employee_id, worked_hours, overtime_hours, status, approved_by")
      .eq("organization_id", organization_id)
      .in("employee_id", employee_ids)
      .gte("attendance_date", pay_period_start)
      .lte("attendance_date", pay_period_end)
      .not("clock_out", "is", null)
      .in("status", ["present", "late", "half_day"]);
    if (requireApproval) {
      attendanceQuery = attendanceQuery.not("approved_by", "is", null);
    }
    const { data: attendanceRecords } = await attendanceQuery;

    const attendanceByEmployee: Record<string, { totalWorkedHours: number; totalOvertimeHours: number; totalHolidayHours: number; daysPresent: number; daysHoliday: number; rowIds: string[] }> = {};
    for (const rec of (attendanceRecords || [])) {
      if (!attendanceByEmployee[rec.employee_id]) {
        attendanceByEmployee[rec.employee_id] = { totalWorkedHours: 0, totalOvertimeHours: 0, totalHolidayHours: 0, daysPresent: 0, daysHoliday: 0, rowIds: [] };
      }
      const agg = attendanceByEmployee[rec.employee_id];
      agg.totalWorkedHours += rec.worked_hours || 0;
      agg.totalOvertimeHours += rec.overtime_hours || 0;
      agg.daysPresent += 1;
      if ((rec as any).id) agg.rowIds.push((rec as any).id);
    }

    // ─── Holiday rows (status='holiday') aggregation ───
    // Public-holiday auto-stamp creates `attendance` rows with status='holiday'.
    // Treat them as paid non-worked by default (holidayHours from expected_hours);
    // if the employee actually worked the holiday (worked_hours>0), the worked
    // hours land here as holiday premium hours alongside the standard day.
    try {
      const { data: holidayRows } = await supabaseAdmin
        .from("attendance")
        .select("id, employee_id, worked_hours, expected_hours, status")
        .eq("organization_id", organization_id)
        .in("employee_id", employee_ids)
        .gte("attendance_date", pay_period_start)
        .lte("attendance_date", pay_period_end)
        .eq("status", "holiday");
      for (const rec of (holidayRows || [])) {
        const empId = (rec as any).employee_id as string;
        if (!attendanceByEmployee[empId]) {
          attendanceByEmployee[empId] = { totalWorkedHours: 0, totalOvertimeHours: 0, totalHolidayHours: 0, daysPresent: 0, daysHoliday: 0, rowIds: [] };
        }
        const agg = attendanceByEmployee[empId];
        const worked = Number((rec as any).worked_hours || 0);
        const expected = Number((rec as any).expected_hours || 0);
        // Worked-holiday: premium = worked hours. Otherwise paid non-worked = expected.
        agg.totalHolidayHours += worked > 0 ? worked : expected;
        agg.daysHoliday += 1;
        if ((rec as any).id) agg.rowIds.push((rec as any).id);
      }
    } catch (holErr) {
      console.warn("[compute-payroll] holiday aggregation skipped:", (holErr as any)?.message ?? holErr);
    }

    // OT pre-approval cap: shrink each employee's overtime to the approved request total.
    const otCapWarnings: string[] = [];
    if (requireOtPreapproval) {
      const { data: otRows } = await supabaseAdmin
        .from("overtime_requests")
        .select("employee_id, requested_hours, status")
        .eq("organization_id", organization_id)
        .eq("status", "approved")
        .in("employee_id", employee_ids)
        .gte("ot_date", pay_period_start)
        .lte("ot_date", pay_period_end);
      const approvedOtByEmployee: Record<string, number> = {};
      for (const r of (otRows || [])) {
        approvedOtByEmployee[(r as any).employee_id] =
          (approvedOtByEmployee[(r as any).employee_id] || 0) + Number((r as any).requested_hours || 0);
      }
      for (const empId of Object.keys(attendanceByEmployee)) {
        const agg = attendanceByEmployee[empId];
        const approved = approvedOtByEmployee[empId] || 0;
        if (agg.totalOvertimeHours > approved) {
          const unapproved = agg.totalOvertimeHours - approved;
          agg.totalOvertimeHours = approved;
          otCapWarnings.push(
            `Employee ${empId.slice(0, 8)}: ${unapproved.toFixed(1)}h overtime excluded — no approved overtime_request.`,
          );
        }
      }
    }





    // ─── Override with timesheet hours for contracts using time_tracking_source='timesheets' ───
    // v_timesheet_payroll_ready aggregates approved+locked timesheet hours per
    // employee per month. We only honor it for employees whose ACTIVE contract
    // has time_tracking_source='timesheets'; all other employees keep their
    // attendance-derived hours. This avoids double-counting.
    const timesheetEmpIds = Object.entries(contractByEmployee)
      .filter(([, c]: [string, any]) => c?.time_tracking_source === "timesheets")
      .map(([empId]) => empId);

    if (timesheetEmpIds.length > 0) {
      // The view is per-month — pull every month touched by the pay period.
      const monthStart = pay_period_start.slice(0, 7) + "-01";
      const { data: tsRows } = await supabaseAdmin
        .from("v_timesheet_payroll_ready")
        .select("employee_id, period_month, total_hours, locked_hours")
        .in("employee_id", timesheetEmpIds)
        .gte("period_month", monthStart)
        .lte("period_month", pay_period_end);

      const tsByEmp: Record<string, number> = {};
      for (const row of (tsRows || []) as any[]) {
        // Prefer locked_hours (approved + period-locked); fall back to total.
        const hrs = Number(row.locked_hours ?? row.total_hours ?? 0);
        tsByEmp[row.employee_id] = (tsByEmp[row.employee_id] || 0) + hrs;
      }

      for (const empId of timesheetEmpIds) {
        const hrs = tsByEmp[empId] || 0;
        const std = payrollSettings.standard_working_days * payrollSettings.standard_hours_per_day;
        const priorHoliday = attendanceByEmployee[empId]?.totalHolidayHours || 0;
        const priorDaysHoliday = attendanceByEmployee[empId]?.daysHoliday || 0;
        // Replace attendance aggregate so downstream OT calc uses timesheets,
        // but preserve any holiday rows already aggregated above.
        attendanceByEmployee[empId] = {
          totalWorkedHours: hrs,
          // Anything beyond standard monthly hours is treated as overtime.
          totalOvertimeHours: Math.max(0, hrs - std),
          totalHolidayHours: priorHoliday,
          daysPresent: Math.min(payrollSettings.standard_working_days, Math.round(hrs / payrollSettings.standard_hours_per_day)),
          daysHoliday: priorDaysHoliday,
          rowIds: [],
        };
      }
    }

    // ─── Fetch approved unpaid leave for the pay period ───
    const { data: leaveRequests } = await supabaseAdmin
      .from("leave_requests")
      .select("employee_id, total_days, leave_type_id")
      .eq("organization_id", organization_id)
      .in("employee_id", employee_ids)
      .eq("status", "approved")
      .lte("start_date", pay_period_end)
      .gte("end_date", pay_period_start);

    const { data: leaveTypes } = await supabaseAdmin
      .from("leave_types")
      .select("id, is_paid")
      .eq("organization_id", organization_id);

    const unpaidLeaveTypeIds = new Set(
      (leaveTypes || []).filter((lt: any) => lt.is_paid === false).map((lt: any) => lt.id)
    );

    const unpaidLeaveDaysByEmployee: Record<string, number> = {};
    for (const lr of (leaveRequests || [])) {
      if (unpaidLeaveTypeIds.has(lr.leave_type_id)) {
        unpaidLeaveDaysByEmployee[lr.employee_id] = (unpaidLeaveDaysByEmployee[lr.employee_id] || 0) + (lr.total_days || 0);
      }
    }

    // ─── Wave 4: pending termination payouts (leave encashment, severance) ───
    // Queued by trg_queue_termination_payouts on employments.status active→terminated.
    // Consumed here, materialised as one-off earnings, marked consumed at end of run.
    const { data: pendingPayouts } = await supabaseAdmin
      .from("pending_termination_payouts")
      .select("id, employee_id, leave_type_id, payout_kind, days_paid, amount, notes")
      .eq("organization_id", organization_id)
      .in("employee_id", employee_ids)
      .eq("status", "pending");
    const payoutsByEmployee: Record<string, Array<{ id: string; kind: string; days: number; amount: number | null; notes: string | null }>> = {};
    for (const p of (pendingPayouts || [])) {
      const arr = payoutsByEmployee[p.employee_id] ?? (payoutsByEmployee[p.employee_id] = []);
      arr.push({
        id: p.id,
        kind: p.payout_kind,
        days: Number(p.days_paid ?? 0),
        amount: p.amount == null ? null : Number(p.amount),
        notes: p.notes,
      });
    }
    const consumedPayoutIds: string[] = [];

    // Index variable earnings by employee_id
    const varEarningsByEmployee: Record<string, VariableEarnings> = {};
    for (const ve of variable_earnings) {
      varEarningsByEmployee[ve.employee_id] = ve;
    }

    // ─── ADR-0010 Gap #2 — data-driven employee-input tokens ───
    // Every `pack_token_registry` row with source='employee' becomes an
    // engine-visible input for this run. Pack-scoped: platform-wide rows
    // (pack_id IS NULL) plus rows on any pack installed for this org.
    // Built-in getters win on collision (see resolveInputs).
    const dynamicEmployeeInputKeys: string[] = await (async () => {
      try {
        const { data: installed } = await supabaseAdmin
          .from("installed_localization_packs")
          .select("pack_id")
          .eq("organization_id", organization_id);
        const packIds = (installed ?? []).map((r: any) => r.pack_id).filter(Boolean);
        let q = supabaseAdmin.from("pack_token_registry").select("token_path,pack_id").eq("source", "employee");
        q = packIds.length > 0
          ? q.or(`pack_id.is.null,pack_id.in.(${packIds.join(",")})`)
          : q.is("pack_id", null);
        const { data } = await q;
        return Array.from(new Set((data ?? []).map((r: any) => String(r.token_path)).filter(Boolean)));
      } catch {
        return [];
      }
    })();


    // ─── Get next payroll number ───
    let finalPayrollNumber = `PAY-PREVIEW`;
    if (!dry_run) {
      const { data: payrollNumber } = await supabaseAdmin.rpc("get_next_payroll_number", {
        _org_id: organization_id,
      });
      finalPayrollNumber = payrollNumber || `PAY-${Date.now()}`;
    }

    // ─── Compute payslips ───
    let totalGross = 0;
    let totalDeductions = 0;
    let totalEmployerContributions = 0;
    let totalNet = 0;
    const runDeductionsSummary: Record<string, number> = {};
    const runContributionsSummary: Record<string, number> = {};
    const payslipsData: any[] = [];
    const warnings: string[] = [...otCapWarnings];
    // Run-scoped sink for rule_type:method strings the engine had to skip.
    // After payroll_runs is inserted we emit one payroll_run_issues row per
    // distinct skip so accountants see exactly what didn't compute.
    const skippedRuleSink = new Set<string>();
    // ruleConfigIssues sink is declared earlier (near the rule-load block) so
    // the rule-loading code that pushes into it doesn't hit a use-before-decl
    // TS error. Do not redeclare it here.
    // Per-employee bracket-progressive trace, drained after the run is
    // inserted into payroll_run_issues (severity=info) for full auditability.
    const bracketTraceSink: Array<{ employee_id: string; traces: BracketTrace[] }> = [];
    // ─── Phase 3 — runStructureEngine per-employee outputs, keyed for the
    // structure-deduction/contrib block downstream and for
    // payroll_rule_traces persistence after payslips insert.
    const graphEarningsByEmployee: Record<string, Record<string, number>> = {};
    // Phase C — per-employee earning-key → accounting_tag map. Populated
    // from engine rule outputs (rule.accounting_tag) so post-payroll-gl
    // can split the salary_expense DR into per-tag buckets. Absent tags
    // fall through to the generic salary_expense mapping — full backward
    // compatibility with runs that leave every rule untagged.
    const graphEarningTagByEmployee: Record<string, Record<string, string | null>> = {};
    const graphDeductionsByEmployee: Record<string, Array<{ code: string; label: string; amount: number }>> = {};
    const graphEmployerByEmployee: Record<string, Array<{ code: string; label: string; amount: number }>> = {};
    const graphTracesByEmployee: Record<string, { structure_id: string; traces: StructureRuleTrace[] }> = {};
    const graphUsedForEmployee = new Set<string>();
    const loanDeductionsToRecord: { loan_id: string; employee_id: string; amount: number; rule_code: string }[] = [];
    // Warn-level run_issues for loans that were skipped or partially recovered.
    // One row per (employee, loan) skip so the run detail panel surfaces it.
    const loanSkipIssues: Array<{
      employee_id: string;
      code: string;
      message: string;
      details: Record<string, unknown>;
    }> = [];

    // ─── Turn C: garnishments + pending expense reimbursements ───
    // Phase 2: also load org policy + per-kind defaults so the engine can
    // apply CCPA-style aggregate caps, always-first ordering (child support),
    // and a minimum-take-home floor.
    // P0 (data-leak fix + correctness): always read garnishment kinds and policy
    // through the resolver RPCs, which apply tenant > pack > platform precedence
    // and are scoped to organization_id. The previous direct table reads against
    // garnishment_kind_defaults had no org filter and would return cross-tenant
    // override rows once tenants started overriding pack defaults.
    const garnishmentsByEmployee: Record<string, any[]> = {};
    const garnKindDefaults: Record<string, KindDefault> = {};
    let garnPolicy: { aggregate_cap_pct: number | null; min_take_home_amount: number | null; min_take_home_pct: number | null } = {
      aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null,
    };
    {
      const { data: resolvedKinds, error: kindsErr } = await supabaseAdmin.rpc(
        "garnishment_resolve_kinds",
        { p_org_id: organization_id },
      );
      if (kindsErr) {
        // Fail loudly. A silent skip here would let the engine finish with
        // garnKindDefaults empty, so always_first / cap-exempt flags default
        // to permissive values and the run posts silently under-deducted.
        throw new Error(
          `garnishment_load_failed: garnishment_resolve_kinds → ${kindsErr.message ?? String(kindsErr)}`,
        );
      }
      for (const d of (resolvedKinds || []) as any[]) {
        garnKindDefaults[d.kind] = {
          default_priority: Number(d.default_priority ?? 100),
          always_first: !!d.always_first,
          counts_toward_aggregate_cap: d.counts_toward_aggregate_cap !== false,
          employer_fee_amount: d.employer_fee_amount != null ? Number(d.employer_fee_amount) : null,
          employer_fee_account_role: d.employer_fee_account_role ?? null,
          calc_model: d.calc_model ?? null,
          priority_class: d.priority_class != null ? Number(d.priority_class) : null,
          aggregate_cap_membership: d.aggregate_cap_membership ?? null,
          protected_earnings_rule: d.protected_earnings_rule ?? null,
        };
      }
      const { data: resolvedPolicy, error: polErr } = await supabaseAdmin.rpc(
        "garnishment_resolve_policy",
        { p_org_id: organization_id },
      );
      if (polErr) {
        throw new Error(
          `garnishment_load_failed: garnishment_resolve_policy → ${polErr.message ?? String(polErr)}`,
        );
      }
      const pol = (resolvedPolicy ?? {}) as Record<string, any>;
      garnPolicy = {
        aggregate_cap_pct: pol.aggregate_cap_pct != null ? Number(pol.aggregate_cap_pct) : null,
        min_take_home_amount: pol.min_take_home_amount != null ? Number(pol.min_take_home_amount) : null,
        min_take_home_pct: pol.min_take_home_pct != null ? Number(pol.min_take_home_pct) : null,
      };
      const { data: garn, error: garnErr } = await supabaseAdmin
        .from("legal_orders_records" as any)
        .select("id, employee_id, kind, priority, cap_rule, fixed_amount, percent_of_disposable, total_owed, total_paid, total_accrued, case_reference, start_date, end_date, status, aggregate_cap_exempt, minimum_take_home_amount")
        .eq("organization_id", organization_id)
        .eq("status", "active")
        .in("employee_id", employee_ids)
        .lte("start_date", pay_period_end)
        .or(`end_date.is.null,end_date.gte.${pay_period_start}`);
      if (garnErr) {
        // Any PostgREST error here (RLS drift, rename cache after the Phase-7
        // employee_garnishments → legal_orders_records migration, missing
        // grant, bad column) previously silently dropped every active order
        // from the run. Fail so payroll_run_jobs surfaces the error to the UI.
        throw new Error(
          `garnishment_load_failed: legal_orders_records select → ${garnErr.message ?? String(garnErr)}`,
        );
      }
      const sorted = [...(garn || [])].sort((a, b) => {
        const aFirst = garnKindDefaults[a.kind]?.always_first ? 0 : 1;
        const bFirst = garnKindDefaults[b.kind]?.always_first ? 0 : 1;
        if (aFirst !== bFirst) return aFirst - bFirst;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (a.start_date || "").localeCompare(b.start_date || "");
      });
      for (const g of sorted) {
        (garnishmentsByEmployee[g.employee_id] ||= []).push(g);
      }
      const distinctEmployees = Object.keys(garnishmentsByEmployee).length;
      console.info(
        `[compute-payroll] loaded ${sorted.length} active legal order(s) for ${distinctEmployees} employee(s) in period ${pay_period_start}..${pay_period_end}`,
      );
    }
    const reimbursementsByEmployee: Record<string, any[]> = {};
    {
      // Only a live, approved expense may be reimbursed. `expense_void` takes a
      // voided expense off the payroll queue, but a run computed in the same
      // window must not pay it either — hence this status filter as well.
      const { data: reimb } = await supabaseAdmin
        .from("expenses")
        .select("id, employee_id, amount, currency, description, expense_date")
        .eq("organization_id", organization_id)
        .eq("reimburse_via_payroll", true)
        .is("reimbursed_payslip_id", null)
        .in("status", ["approved", "paid"])
        .in("employee_id", employee_ids)
        .lte("expense_date", pay_period_end);
      for (const r of reimb || []) {
        if (r.employee_id) (reimbursementsByEmployee[r.employee_id] ||= []).push(r);
      }
    }
    // P6 — Carry-forward: load any prior unfulfilled garnishment shortfalls
    // for the employees in this run. The engine will try to recover them on
    // top of the period's normal request, still respecting disposable / cap /
    // floor / total_owed limits.
    const pendingCfByGarn: Record<string, { totalPending: number; ids: string[] }> = {};
    {
      const { data: cf, error: cfErr } = await supabaseAdmin
        .from("garnishment_carry_forward")
        .select("id, garnishment_id, shortfall_amount")
        .eq("organization_id", organization_id)
        .is("consumed_by_run_id", null)
        .in("employee_id", employee_ids);
      if (cfErr) {
        throw new Error(
          `garnishment_load_failed: garnishment_carry_forward select → ${cfErr.message ?? String(cfErr)}`,
        );
      }
      for (const row of cf || []) {
        const slot = (pendingCfByGarn[row.garnishment_id] ||= { totalPending: 0, ids: [] });
        slot.totalPending = Math.round((slot.totalPending + Number(row.shortfall_amount || 0)) * 100) / 100;
        slot.ids.push(row.id);
      }
    }

    const cfInserts: Array<Record<string, unknown>> = [];
    const cfConsumedIds: string[] = [];

    const garnishmentsApplied: { id: string; amount: number; employee_id: string }[] = [];
    // Observability: any employee who had ≥1 in-window active legal order but
    // whose garnishment engine result withheld nothing. Silent drops here in
    // the past hid a Kenya-pack policy-fraction bug for weeks — surface it
    // as a first-class run issue so it can never happen invisibly again.
    const garnishmentZeroIssues: Array<{
      employee_id: string;
      order_ids: string[];
      order_count: number;
      disposable: number;
      gross: number;
      pre_garnishment_deductions: number;
      aggregate_cap_pct: number | null;
      min_take_home_pct: number | null;
      min_take_home_amount: number | null;
    }> = [];
    const reimbursementsConsumed: { id: string; employee_id: string }[] = [];



    for (const emp of employees) {
      // Skip employees gated by Stage 7 timesheet-approval requirement.
      if (skippedEmployees.has(emp.id)) {
        const reason = skippedEmployees.get(emp.id)!;
        warnings.push(`${emp.first_name} ${emp.last_name}: ${reason.message}`);
        continue;
      }
      const _empPhaseStart = Date.now();
      phase("employee-loop-start", { emp: emp.employee_number });
      // Cancellation check between employees (cooperative).
      if (!dry_run && (await isCancelled())) {
        warnings.push(`Payroll cancelled by user after ${payslipsData.length}/${employees.length} employees.`);
        await finalizeJob("failed", {
          errorCode: "CANCELLED",
          errorMessage: `Cancelled after ${payslipsData.length} of ${employees.length} employees.`,
        });
        return new Response(JSON.stringify({ cancelled: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Heartbeat every employee so the UI progress bar is truthful even on
      // small runs (previous mod-5 gate left <5-employee runs at 0/N).
      await heartbeat("computing", { current: payslipsData.length, total: employees.length });
      // ─── Salary source: salary structure → contract → reject ───
      const contract = contractByEmployee[emp.id];
      let basicSalary: number;
      let housingAllowance: number;
      let transportAllowance: number;
      let otherEarnings: Record<string, number>;
      let salarySource = "contract";

      const structureComponents = contract?.salary_structure_id
        ? componentsByStructure[contract.salary_structure_id] || []
        : [];
      const employeeRuleSet = contract?.salary_structure_id
        ? ruleSetByStructure[contract.salary_structure_id] || null
        : null;

      // ─── Fail-loud compensation enforcement (post compensation-mode gating) ───
      // Contracts that declare compensation_mode='structure' MUST resolve to a
      // non-empty published rule set; we no longer silently fall back to the
      // flat-wage path because that hid structure-misconfiguration bugs until
      // the payslip looked wrong. Activation should already block this at the
      // DB layer, but compute-payroll is the last line of defence.
      if (contract && contract.compensation_mode === "structure" && (!contract.salary_structure_id || structureComponents.length === 0)) {
        return new Response(JSON.stringify({
          error:
            `${emp.first_name} ${emp.last_name} (${emp.employee_number}): contract uses 'structure' compensation but ` +
            (!contract.salary_structure_id
              ? "no salary structure is linked."
              : "the linked salary structure has no active components."),
          code: "CONTRACT_COMPENSATION_INCOMPLETE",
          employee_id: emp.id,
          contract_id: contract.id,
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── Phase 3 — Rule-graph engine branch ───
      // Runs BEFORE the legacy 2-pass resolver. When the structure has
      // `use_structure_engine=true` and at least one active
      // `payroll_salary_rules` row, we invoke `runStructureEngine` and map
      // its category outputs onto the same locals the downstream engine
      // reads. Any cycle / expression / unresolved-token error is fatal —
      // we do NOT silently fall through to the legacy path, otherwise
      // graph-authored math would appear to "work" while being ignored.
      const sid = contract?.salary_structure_id;
      const graphRules = sid ? (structureRulesByStructure[sid] || []) : [];
      const graphOn = Boolean(sid && structureUsesEngine[sid] && graphRules.length > 0);
      if (graphOn && contract) {
        const traceSink: StructureRuleTrace[] = [];
        const empWorkEntries: WorkEntryRow[] = (workEntriesByEmployee?.[emp.id] || []).map((e: any) => ({
          work_entry_type_id: e.work_entry_type_id ?? null,
          hours: Number(e.hours || 0),
          overtime_hours: Number(e.overtime_hours || 0),
          days: e.days != null ? Number(e.days) : undefined,
        }));
        const engineRes = runStructureEngine({
          rules: graphRules,
          workEntryTypes,
          workEntries: empWorkEntries,
          employee: {
            id: emp.id,
            department_id: emp.department_id ?? null,
            job_title: emp.job_title ?? null,
          } as any,
          contract: {
            id: contract.id,
            wage: contract.wage,
            currency: contract.currency ?? null,
          } as any,
          traceSink,
        });
        if (engineRes.errors.length > 0) {
          const first = engineRes.errors[0];
          return new Response(JSON.stringify({
            error:
              `${emp.first_name} ${emp.last_name} (${emp.employee_number}): salary rule-graph error on rule '${first.rule_code}' — ${first.message}`,
            code: "STRUCTURE_ENGINE_ERROR",
            employee_id: emp.id,
            contract_id: contract.id,
            structure_id: sid,
            errors: engineRes.errors,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        graphUsedForEmployee.add(emp.id);
        graphTracesByEmployee[emp.id] = { structure_id: sid!, traces: traceSink };

        const baseWage = contract.wage || 0;
        basicSalary = 0;
        housingAllowance = 0;
        transportAllowance = 0;
        otherEarnings = {};
        const otherEarn: Record<string, number> = {};
        const tagByKey: Record<string, string | null> = {};
        for (const line of engineRes.lines) {
          const codeLc = (line.code || "").toLowerCase();
          if (line.category === "basic") {
            basicSalary += line.amount;
            if (line.accounting_tag) tagByKey["basic"] = line.accounting_tag;
          } else if (line.category === "allowance") {
            if (codeLc === "housing" || codeLc === "housing_allowance" || codeLc === "hra") {
              housingAllowance += line.amount;
              if (line.accounting_tag) tagByKey["housing_allowance"] = line.accounting_tag;
            } else if (codeLc === "transport" || codeLc === "transport_allowance") {
              transportAllowance += line.amount;
              if (line.accounting_tag) tagByKey["transport_allowance"] = line.accounting_tag;
            } else {
              const k = line.name || line.code;
              otherEarn[k] = (otherEarn[k] || 0) + line.amount;
              if (line.accounting_tag) tagByKey[k] = line.accounting_tag;
            }
          } else if (line.category === "deduction") {
            (graphDeductionsByEmployee[emp.id] ||= []).push({
              code: `graph_${line.code}`,
              label: line.name || line.code,
              amount: line.amount,
            });
          } else if (line.category === "employer_contribution") {
            (graphEmployerByEmployee[emp.id] ||= []).push({
              code: `graph_${line.code}`,
              label: line.name || line.code,
              amount: line.amount,
            });
          }
        }
        otherEarnings = otherEarn;
        graphEarningTagByEmployee[emp.id] = tagByKey;
        if (basicSalary === 0) basicSalary = baseWage;
        graphEarningsByEmployee[emp.id] = { basic: basicSalary, housing: housingAllowance, transport: transportAllowance };
        salarySource = "salary_structure_graph";
      } else if (contract && structureComponents.length > 0) {
        const baseWage = contract.wage || 0;
        basicSalary = 0;
        housingAllowance = 0;
        transportAllowance = 0;
        otherEarnings = {};

        // Two-pass component resolution
        const resolvedComponents: Record<string, number> = {};
        const percentageComps: typeof structureComponents = [];

        for (const comp of structureComponents) {
          if (comp.component_type !== "earning") continue;
          const code = (comp.code || "").toLowerCase();

          if (comp.computation_type === "fixed") {
            const amount = comp.computation_value || 0;
            resolvedComponents[code] = amount;
          } else if (comp.computation_type === "percentage") {
            percentageComps.push(comp);
          }
        }

        if (!resolvedComponents["basic"] && !resolvedComponents["basic_salary"]) {
          resolvedComponents["basic"] = baseWage;
          resolvedComponents["basic_salary"] = baseWage;
        }

        for (const comp of percentageComps) {
          const code = (comp.code || "").toLowerCase();
          const refKey = (comp.percentage_of || "basic").toLowerCase();

          let percentBase: number;
          if (refKey === "gross") {
            percentBase = Object.values(resolvedComponents).reduce((s, v) => s + v, 0);
          } else if (resolvedComponents[refKey] !== undefined) {
            percentBase = resolvedComponents[refKey];
          } else {
            percentBase = baseWage;
          }

          resolvedComponents[code] = Math.round(percentBase * ((comp.computation_value || 0) / 100) * 100) / 100;
        }

        for (const comp of structureComponents) {
          if (comp.component_type !== "earning") continue;
          const code = (comp.code || "").toLowerCase();
          const amount = resolvedComponents[code] || 0;

          if (code === "basic" || code === "basic_salary") {
            basicSalary = amount || baseWage;
          } else if (code === "housing" || code === "housing_allowance" || code === "hra") {
            housingAllowance = amount;
          } else if (code === "transport" || code === "transport_allowance") {
            transportAllowance = amount;
          } else {
            otherEarnings[comp.name || comp.code] = amount;
          }
        }

        if (basicSalary === 0) basicSalary = baseWage;
        salarySource = "salary_structure";
      } else if (contract) {
        basicSalary = contract.wage || 0;
        housingAllowance = contract.housing_allowance || 0;
        transportAllowance = contract.transport_allowance || 0;
        otherEarnings = (contract.other_allowances as Record<string, number>) || {};
        salarySource = "contract";
      } else {
        return new Response(JSON.stringify({
          error: `${emp.first_name} ${emp.last_name} (${emp.employee_number}) has no active contract for this pay period. Create a contract before running payroll.`,
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── Proration for partial months ───
      // Employment window is contract-first (contract.start_date / end_date),
      // falling back to employees.hire_date / termination_date only when no
      // active contract row exists. Contracts are the single source of truth
      // for wage AND employment validity; hire_date stays for HR/tenure use.



      // ─── Phase 3.1 — Suppress recurring earnings per run-type policy ───
      // Off-cycle / bonus / commission / 13th-month / supplemental / correction
      // do NOT pay the regular salary stream; only variable / supplemental
      // earnings (and, for termination, the policy-declared accruals) flow
      // through. Statutory deductions still compute on whatever earnings remain.
      if (!runTypePolicy.applies_recurring_earnings) {
        basicSalary = 0;
        housingAllowance = 0;
        transportAllowance = 0;
        otherEarnings = {};
        salarySource = `${salarySource}+suppressed_by_${runType}`;
      }

      const rawContractStart: string | null = contract?.start_date ?? null;
      const hireDate: string | null = emp.hire_date ?? null;
      // Employment envelope: the active contract is the SOURCE OF TRUTH for
      // the employment window. `employees.hire_date` is an HR/tenure field
      // that is often auto-defaulted by the employee form to "today" and
      // therefore cannot be trusted as a hard floor — if it were, a contract
      // signed Jan 1 with hire_date silently set to Jun 4 would skip every
      // run before June and underpay the June run. When a contract exists we
      // use `contract.start_date` and only warn (for auditability) when
      // `hire_date` disagrees. If there is no contract we fall back to
      // hire_date so legacy/contract-less employees still prorate sensibly.
      let effectiveStartDate: string | null = rawContractStart ?? hireDate;
      let startSource: string = rawContractStart ? "contract" : (hireDate ? "hire_date" : "none");
      if (rawContractStart && hireDate && hireDate > rawContractStart) {
        // contract wins; surface the drift so HR can reconcile the records.
        startSource = "contract_overrides_hire_date";
        warnings.push(
          `${emp.first_name} ${emp.last_name} (${emp.employee_number}): hire_date ${hireDate} is later than contract start ${rawContractStart} — using contract start (contract is the source of truth for the employment window). Reconcile employees.hire_date in HR.`
        );
      }
      const contractEnd: string | null = contract?.end_date ?? null;
      const termEnd: string | null = emp.termination_date ?? null;
      let effectiveEndDate: string | null = null;
      if (contractEnd && termEnd) {
        effectiveEndDate = contractEnd < termEnd ? contractEnd : termEnd;
      } else {
        effectiveEndDate = contractEnd ?? termEnd ?? null;
      }
      const endSource = effectiveEndDate
        ? (effectiveEndDate === contractEnd ? "contract" : "termination_date")
        : "open";

      let prorationFactor = calculateProrationFactor(
        pay_period_start, pay_period_end,
        effectiveStartDate, effectiveEndDate
      );

      // Optional manual override — accountant decision (audit-tracked in
      // warnings + payslip input rows). Forces factor=1 when full_period.
      const override = proration_overrides?.[emp.id];
      const overrideApplied = !!(override?.full_period && prorationFactor < 1);
      const computedFactorBeforeOverride = prorationFactor;
      if (overrideApplied) {
        prorationFactor = 1;
        warnings.push(
          `${emp.first_name} ${emp.last_name} (${emp.employee_number}): proration overridden to 100% ` +
          `(would have been ${(computedFactorBeforeOverride * 100).toFixed(1)}%) — reason: ${override!.reason || "no reason supplied"}.`
        );
      }

      const windowDesc =
        `effective window ${effectiveStartDate ?? "open"}..${effectiveEndDate ?? "open"} ` +
        `(start source: ${startSource}, end source: ${endSource})`;

      if (prorationFactor === 0) {
        warnings.push(
          `${emp.first_name} ${emp.last_name} (${emp.employee_number}): not employed during ` +
          `${pay_period_start}..${pay_period_end} — ${windowDesc}. Skipping.`
        );
        continue;
      }

      if (prorationFactor < 1) {
        warnings.push(
          `${emp.first_name} ${emp.last_name} (${emp.employee_number}): prorated at ` +
          `${(prorationFactor * 100).toFixed(1)}% for partial month — ${windowDesc}.`
        );
      } else {
        console.log(
          `[compute-payroll] ${emp.employee_number}: full period (factor=1) — ${windowDesc}.`
        );
      }


      // Capture pre-proration baselines so the payslip PDF can show
      // "contract wage × factor = prorated amount" per earning line.
      const preProration = {
        basic: basicSalary,
        housing: housingAllowance,
        transport: transportAllowance,
        other: { ...otherEarnings } as Record<string, number>,
      };

      // Apply proration to fixed earnings
      basicSalary = Math.round(basicSalary * prorationFactor * 100) / 100;
      housingAllowance = Math.round(housingAllowance * prorationFactor * 100) / 100;
      transportAllowance = Math.round(transportAllowance * prorationFactor * 100) / 100;
      for (const key of Object.keys(otherEarnings)) {
        otherEarnings[key] = Math.round((otherEarnings[key] || 0) * prorationFactor * 100) / 100;
      }

      const otherEarningsTotal = Object.values(otherEarnings).reduce((sum: number, val: any) => sum + (val || 0), 0);

      // ─── Variable earnings (not prorated — they are actuals) ───
      const varEarnings = varEarningsByEmployee[emp.id] || {};
      const attendance = attendanceByEmployee[emp.id];

      let overtimePay = varEarnings.overtime_pay || 0;
      if (overtimePay === 0 && attendance && attendance.totalOvertimeHours > 0) {
        const monthlyHours = payrollSettings.standard_working_days * payrollSettings.standard_hours_per_day;
        const hourlyRate = (contract?.wage || 0) / monthlyHours;
        overtimePay = Math.round(attendance.totalOvertimeHours * hourlyRate * payrollSettings.overtime_multiplier * 100) / 100;
        warnings.push(`${emp.first_name} ${emp.last_name}: overtime calculated from ${attendance.totalOvertimeHours.toFixed(1)}h attendance records (${overtimePay.toFixed(2)}).`);
      }
      const bonus = varEarnings.bonus || 0;
      const commission = varEarnings.commission || 0;
      const arrears = varEarnings.arrears || 0;
      const otherVariableTotal = Object.entries(varEarnings)
        .filter(([k]) => !["employee_id", "overtime_pay", "bonus", "commission", "arrears"].includes(k))
        .reduce((sum, [, v]) => sum + (Number(v) || 0), 0);

      const allOtherEarnings = { ...otherEarnings };
      if (commission > 0) allOtherEarnings["commission"] = commission;
      if (arrears > 0) allOtherEarnings["arrears"] = arrears;
      for (const [k, v] of Object.entries(varEarnings)) {
        if (!["employee_id", "overtime_pay", "bonus", "commission", "arrears"].includes(k) && Number(v) > 0) {
          allOtherEarnings[k] = Number(v);
        }
      }

      // ─── Leave deduction (unpaid leave) ───
      const unpaidLeaveDays = unpaidLeaveDaysByEmployee[emp.id] || 0;
      let leaveDeduction = 0;
      if (unpaidLeaveDays > 0) {
        const rawBasic = contract?.wage || 0;
        const dailyRate = rawBasic / payrollSettings.standard_working_days;
        leaveDeduction = Math.round(unpaidLeaveDays * dailyRate * 100) / 100;
        warnings.push(`${emp.first_name} ${emp.last_name}: ${unpaidLeaveDays} unpaid leave day(s) deducted (${leaveDeduction.toFixed(2)}).`);
      }

      // ─── Wave 4: termination payouts (leave encashment, severance, notice) ───
      // Pulled from pending_termination_payouts; days × daily-rate when amount is null.
      const empPayouts = payoutsByEmployee[emp.id] || [];
      let terminationPayoutTotal = 0;
      const terminationPayoutLines: Array<{ kind: string; label: string; amount: number; days: number; notes: string | null }> = [];
      if (empPayouts.length > 0) {
        const rawBasic = contract?.wage || 0;
        const dailyRate = rawBasic / Math.max(1, payrollSettings.standard_working_days);
        for (const p of empPayouts) {
          const amt = p.amount != null ? p.amount : Math.round(p.days * dailyRate * 100) / 100;
          if (amt <= 0) continue;
          terminationPayoutTotal += amt;
          const label = p.kind === "leave_encashment" ? "Leave Encashment"
            : p.kind === "severance" ? "Severance Pay"
            : p.kind === "notice" ? "Notice Pay"
            : "Termination Payout";
          terminationPayoutLines.push({ kind: p.kind, label, amount: amt, days: p.days, notes: p.notes });
          consumedPayoutIds.push(p.id);
        }
        if (terminationPayoutTotal > 0) {
          warnings.push(`${emp.first_name} ${emp.last_name}: termination payouts applied (${terminationPayoutTotal.toFixed(2)}).`);
        }
      }

      const grossPay = basicSalary + housingAllowance + transportAllowance + otherEarningsTotal +
        overtimePay + bonus + commission + arrears + otherVariableTotal + terminationPayoutTotal - leaveDeduction;
      // Phase 4: pick the rule slice for THIS employee's jurisdiction.
      // Falls back to the run-level / business-default country slice.
      const empCountry = resolveEmployeeCountry(emp);
      const empRules: PayrollRule[] = empCountry
        ? (rulesByCountry[empCountry] || statutoryRules)
        : statutoryRules;

      // Stage-C guard: if a country is resolved for the employee but no
      // statutory rules are configured for it, surface a blocker rather
      // than silently emit a zero-deduction payslip. This is the safety
      // net for freshly-installed localization packs that ship without
      // payroll templates (e.g. the skeleton GH/NG/TZ/UG/ZA packs).
      if (empCountry && empRules.length === 0) {
        ruleConfigIssues.push({
          employee_id: emp.id,
          code: "NO_STATUTORY_RULES_FOR_COUNTRY",
          severity: "blocker",
          message:
            `No active payroll_statutory_rules rows found for country_code='${empCountry}'. ` +
            `Install or populate the localization pack for ${empCountry} (PAYE / social security / health / housing / ` +
            `employer contributions) before running payroll for ${emp.first_name} ${emp.last_name}.`,
          details: { employee_id: emp.id, country_code: empCountry },
        });
        skippedEmployees.set(emp.id, {
          code: "NO_STATUTORY_RULES_FOR_COUNTRY",
          message: `No active payroll_statutory_rules rows for country_code='${empCountry}'.`,
          details: { country_code: empCountry },
        });
        continue;
      }

      // Generic taxable-income adjustment. The only supported source is
      // PAYE rule.parameters.taxable_income_adjustments[]. The legacy
      // `rule_type='housing_exemption'` sentinel was removed in Phase 3.
      const { housingExempt: exemptHousing } = computeTaxableIncomeAdjustments(
        empRules,
        housingAllowance,
      );
      const taxableIncome = grossPay - exemptHousing;

      // Generic deduction / contribution accumulators (keyed by rule_name so
      // multiple statutory deductions sharing the same rule_type — NSSF, SHIF,
      // AHL, NHIF — stay distinct on the payslip).
      const deductionsDetail: Record<string, number> = {};
      const contributionsDetail: Record<string, number> = {};
      // Actual PAYE base after pass-A statutory reductions; persisted on
      // the payslip so audits can see exactly what was taxed.
      let finalTaxableBase = taxableIncome;

      if (empRules.length > 0) {

        // Two-pass evaluation so that statutory deductions flagged
        // `parameters.reduces_taxable_income = true` (e.g. KE NSSF, SHIF,
        // AHL; approved pension) reduce the PAYE base BEFORE any
        // bracket_progressive income tax is computed. Without this pass,
        // PAYE is taxed on gross — which over-charges KE employees by
        // thousands per month (Finance Acts 2023/2024 make NSSF/SHIF/AHL
        // allowable deductions). The dispatch is purely off the flag —
        // no literal rule_code branches, so non-KE packs that don't ship
        // the flag stay byte-identical.
        // ADR-0010 Gap #2/#3 — dynamic input keys + per-run variable
        // earnings (bonus_amount, overtime_amount, commission, arrears)
        // are surfaced as ctx.inputs so bonus_windfall /
        // overtime_concessional / pack-registered tokens work without
        // touching engine code.
        const ve = varEarningsByEmployee[emp.id] ?? {};
        const variableInputs: Record<string, number> = {
          bonus_amount: Number(ve.bonus ?? 0),
          overtime_amount: Number(ve.overtime_pay ?? 0),
          commission_amount: Number(ve.commission ?? 0),
          arrears_amount: Number(ve.arrears ?? 0),
        };
        const ctx: CalcContext = {
          grossPay,
          taxableIncome,
          basicSalary,
          inputs: resolveInputs(emp, dynamicEmployeeInputKeys, variableInputs),
        };
        const empBracketTraces: BracketTrace[] = [];

        // Deductibility is expressed in TWO equivalent forms across packs
        // (see ADR-0010 / payroll audit 2026-07-05):
        //   (a) `parameters.reduces_taxable_income = true` on each sibling
        //       statutory rule (imperative form), OR
        //   (b) `parameters.pre_tax_deductions = [<rule_code>, ...]` on the
        //       income_tax rule (declarative form — how the shipped KE
        //       pack encodes NSSF/SHIF/AHL pre-tax).
        // The engine must honour BOTH so the pack is the single source of
        // truth. This keeps ADR-0036 country-agnostic — dispatch is still
        // off `parameters`, never off literal rule_codes.
        const incomeTaxRules = empRules.filter((r) => r.rule_type === "income_tax");
        const preTaxCodes = new Set<string>();
        for (const it of incomeTaxRules) {
          const arr = (it.parameters as any)?.pre_tax_deductions;
          if (Array.isArray(arr)) {
            for (const c of arr) {
              if (typeof c === "string" && c.length > 0) {
                preTaxCodes.add(c.toLowerCase());
              }
            }
          }
        }
        const isDeductible = (r: PayrollRule) =>
          (r.parameters as any)?.reduces_taxable_income === true ||
          preTaxCodes.has((r.rule_code || "").toLowerCase());
        const passA = empRules.filter(isDeductible);
        const passB = empRules.filter((r) => !isDeductible(r));

        const taxableBaseComponents: Array<{ rule_code: string; rule_name: string; amount: number }> = [];
        let statutoryDeductible = 0;

        // Pass A — deductibles. Use the original (gross-based) ctx so
        // percentage_of_gross rules see the correct base. Their
        // employee_amount accumulates into statutoryDeductible.
        for (const rule of passA) {
          const res = computeOneRule(rule, ctx, skippedRuleSink, empBracketTraces);
          if (!res) continue;
          if (res.employee_amount > 0) {
            deductionsDetail[res.rule_name] = (deductionsDetail[res.rule_name] || 0) + res.employee_amount;
            statutoryDeductible += res.employee_amount;
            taxableBaseComponents.push({
              rule_code: rule.rule_code,
              rule_name: rule.rule_name,
              amount: res.employee_amount,
            });
          }
          if (res.employer_amount > 0) {
            contributionsDetail[res.rule_name] = (contributionsDetail[res.rule_name] || 0) + res.employer_amount;
          }
        }

        // ─── Employee-input pre-tax deductions (audit 2026-07-05 closeout) ───
        // `pre_tax_deductions[]` may reference codes that are NOT sibling
        // statutory rules but employee compensation components (KE pack:
        // pension_contribution, mortgage_interest, post_retirement_medical).
        // These arrive through EMPLOYEE_INPUT_REGISTRY / ctx.inputs and are
        // capped by any matching `reliefs[]` entry of kind='deduction_cap'.
        // Country-agnostic: the engine reads codes, never country strings.
        const deductionCapByCode = new Map<string, number>();
        for (const it of incomeTaxRules) {
          const reliefsArr = (it.parameters as any)?.reliefs;
          if (!Array.isArray(reliefsArr)) continue;
          for (const r of reliefsArr) {
            if (r && String(r.kind ?? "").toLowerCase() === "deduction_cap") {
              const bc = String(r.base_code ?? "").toLowerCase();
              const cap = Number(r.cap ?? 0);
              if (bc && cap > 0) deductionCapByCode.set(bc, cap);
            }
          }
        }
        const siblingRuleCodes = new Set(
          empRules.map((r) => (r.rule_code || "").toLowerCase()).filter(Boolean),
        );
        for (const code of preTaxCodes) {
          // Already handled as a sibling statutory rule.
          if (siblingRuleCodes.has(code)) continue;
          const raw = Number(ctx.inputs?.[code] ?? 0);
          if (raw <= 0) continue;
          const cap = deductionCapByCode.get(code);
          const applied = cap != null ? Math.min(raw, cap) : raw;
          if (applied <= 0) continue;
          statutoryDeductible += applied;
          taxableBaseComponents.push({
            rule_code: code,
            rule_name: cap != null && raw > cap ? `${code} (capped at ${cap})` : code,
            amount: applied,
          });
        }

        // ─── Exemption reliefs (kind='exemption') ───
        // Reduce the taxable base by a flat amount when the declared
        // condition is truthy (e.g. KE disability_exemption gated on
        // disability_certified). Applied here in Pass A so the taxable
        // base reflects the exemption before bracket computation.
        for (const it of incomeTaxRules) {
          const reliefsArr = (it.parameters as any)?.reliefs;
          if (!Array.isArray(reliefsArr)) continue;
          for (const r of reliefsArr) {
            if (!r || String(r.kind ?? "").toLowerCase() !== "exemption") continue;
            if (r.condition) {
              const gate = ctx.inputs?.[String(r.condition)];
              if (!gate) continue;
            }
            const amt = Number(r.amount ?? 0);
            if (amt <= 0) continue;
            statutoryDeductible += amt;
            taxableBaseComponents.push({
              rule_code: String(r.code ?? "exemption"),
              rule_name: String(r.code ?? "exemption"),
              amount: amt,
            });
          }
        }

        // Reduce the taxable base by the accumulated deductibles, clamped ≥ 0.
        if (statutoryDeductible > 0) {
          ctx.taxableIncome = Math.max(0, taxableIncome - statutoryDeductible);
        }
        finalTaxableBase = ctx.taxableIncome;



        // Pass B — everything else (income_tax / employer-only / flat levies).
        //
        // Phase 3.6 — Tax-method dispatch. For non-`ordinary` runs (bonus,
        // 13th-month, etc.), bracket_progressive rules go through
        // applyTaxMethod(); everything else and `ordinary` runs are
        // byte-identical to the legacy path.
        const taxMethod = (runTypePolicy.tax_method || "ordinary").toLowerCase();
        const dispatchTax = taxMethod !== "ordinary";
        const empTaxFallbacks: Array<{ rule_code: string; rule_name: string; requested_method: string; reason: string }> = [];

        for (const rule of passB) {
          let res = computeOneRule(rule, ctx, skippedRuleSink, empBracketTraces);
          if (dispatchTax && (rule.computation_method || "").toLowerCase() === "bracket_progressive") {
            const dispatched = applyTaxMethod(
              rule,
              ctx,
              taxMethod,
              inferPeriodsPerYear(pay_period_start, pay_period_end),
              empTaxFallbacks,
              empBracketTraces,
            );
            if (dispatched) {
              // Method recognised + produced a value — override the ordinary calc.
              res = {
                rule_id: rule.id,
                rule_type: rule.rule_type,
                rule_name: rule.rule_name,
                label: rule.rule_name,
                employee_amount: dispatched.employee,
                employer_amount: dispatched.employer,
                category: "statutory_employee",
              };
            }
            // dispatched === null → either rule wasn't bracket_progressive
            // (impossible here) or method asked for fallback. Either way we
            // keep the ordinary `res` and let the fallback issue surface.
          }
          if (!res) continue;
          if (res.employee_amount > 0) {
            deductionsDetail[res.rule_name] = (deductionsDetail[res.rule_name] || 0) + res.employee_amount;
          }
          if (res.employer_amount > 0) {
            contributionsDetail[res.rule_name] = (contributionsDetail[res.rule_name] || 0) + res.employer_amount;
          }
        }

        // Surface every requested-but-unmet tax method as a structured warning
        // so audit can see "we asked for separate_rate, fell back to ordinary
        // because the rule had no separate_rate_pct configured".
        for (const fb of empTaxFallbacks) {
          warnings.push(
            `${emp.first_name} ${emp.last_name}: tax method '${fb.requested_method}' could not be applied to ${fb.rule_code} — ${fb.reason}; fell back to ordinary brackets.`,
          );
          // Structured per-employee detail is captured in the warning above.
          // We deliberately do NOT push to a payroll_run_issues sink here —
          // this function has no such sink wired, and adding one is a
          // separate slice (would also require a migration to extend the
          // run-issues code check with BONUS_TAX_METHOD_FALLBACK).
        }


        // Annotate each bracket trace with the composition of its taxable
        // base so the payslip explainer can render
        // "Taxable = Gross − NSSF − SHIF − AHL − Housing exempt".
        if (taxableBaseComponents.length > 0 || exemptHousing > 0) {
          for (const t of empBracketTraces) {
            (t as any).taxable_base_components = [
              { rule_code: "__gross__", rule_name: "Gross pay", amount: grossPay },
              ...(exemptHousing > 0
                ? [{ rule_code: "__housing_exempt__", rule_name: "Housing allowance (exempt)", amount: -exemptHousing }]
                : []),
              ...taxableBaseComponents.map((c) => ({ ...c, amount: -c.amount })),
            ];
          }
        }

        if (empBracketTraces.length > 0) {
          bracketTraceSink.push({ employee_id: emp.id, traces: empBracketTraces });
        }
        // Expose the traces to the payslip_lines emitter so the PDF /
        // explainer popover can render "How PAYE was computed" from
        // `source.bracket_breakdown`. Key by rule_name because
        // deductionsDetail is keyed by rule_name.
        (emp as any).__bracket_traces_by_rule_name = Object.fromEntries(
          empBracketTraces.map((t) => [t.rule_name, t]),
        );
      }



      // ─── Salary structure deduction/contribution components ───
      // Phase 3: when the rule-graph engine ran for this employee, its
      // deduction + employer_contribution lines take the place of the
      // flat-component walk. Structures without the flag continue to use
      // the legacy walk unchanged.
      if (graphUsedForEmployee.has(emp.id)) {
        for (const d of graphDeductionsByEmployee[emp.id] || []) {
          if (d.amount > 0) deductionsDetail[d.label] = (deductionsDetail[d.label] || 0) + d.amount;
        }
        for (const c of graphEmployerByEmployee[emp.id] || []) {
          if (c.amount > 0) contributionsDetail[c.label] = (contributionsDetail[c.label] || 0) + c.amount;
        }
      } else if (structureComponents.length > 0) {
        for (const comp of structureComponents) {
          if (comp.component_type === "earning") continue;

          let amount = 0;
          if (comp.computation_type === "fixed") {
            amount = comp.computation_value || 0;
          } else if (comp.computation_type === "percentage") {
            const percentBase = comp.percentage_of === "gross" ? grossPay : basicSalary;
            amount = Math.round(percentBase * (comp.computation_value / 100) * 100) / 100;
          }

          if (amount <= 0) continue;
          const label = comp.name || comp.code;

          if (comp.component_type === "deduction") {
            deductionsDetail[label] = (deductionsDetail[label] || 0) + amount;
          } else if (comp.component_type === "employer_contribution") {
            contributionsDetail[label] = (contributionsDetail[label] || 0) + amount;
          }
        }
      }

      // ─── Benefit plan deductions ───
      const empBenefits = runTypePolicy.applies_recurring_deductions ? (benefitsByEmployee[emp.id] || []) : [];
      for (const plan of empBenefits) {
        const empContrib = plan.employee_contribution || 0;
        const erContrib = plan.employer_contribution || 0;
        const label = `benefit_${plan.benefit_type || plan.name}`;

        if (empContrib > 0) {
          let empAmount = empContrib;
          if (plan.contribution_type === "percentage") {
            empAmount = Math.round(basicSalary * (empContrib / 100) * 100) / 100;
          }
          deductionsDetail[label] = (deductionsDetail[label] || 0) + empAmount;
        }

        if (erContrib > 0) {
          let erAmount = erContrib;
          if (plan.contribution_type === "percentage") {
            erAmount = Math.round(basicSalary * (erContrib / 100) * 100) / 100;
          }
          contributionsDetail[label] = (contributionsDetail[label] || 0) + erAmount;
        }
      }

      // ─── Loan deductions ───
      // Per-loan-type behavior driven by `repayment_method`. Each loan also
      // honors its `min_net_pay_floor` and `max_pct_of_net` so the engine
      // never drives provisional net below the configured floor.
      const empLoans = runTypePolicy.applies_loan_installments ? (loansByEmployee[emp.id] || []) : [];
      const preLoanDeductions = Object.values(deductionsDetail).reduce((s, v) => s + v, 0);
      let provisionalNet = Math.max(0, grossPay - preLoanDeductions);

      for (const loan of empLoans) {
        // ── Honour approved skip overrides ──
        // For non-fixed_installment loans the override is per-loan-per-run.
        // For fixed_installment loans the override is per-installment;
        // `nextInstallmentByLoan` has already had that installment pruned
        // above, so wanted naturally collapses to 0 / next installment.
        if (skippedLoanIds.has(loan.id) && loan.repayment_method !== "fixed_installment") {
          loanSkipIssues.push({
            employee_id: emp.id,
            code: "RUN_LOAN_SKIP_OVERRIDE",
            message: `Loan ${loan.loan_number} deduction skipped — approved override applied.`,
            details: { loan_id: loan.id, loan_number: loan.loan_number, reason: "approved_override" },
          });
          continue;
        }

        // Phase C: refuse to deduct when the loan_type requires a schedule but
        // no loan_repayment_schedule row exists. This surfaces as a run issue
        // so the payroll officer can generate the schedule and re-run, rather
        // than silently under-recovering the balance.
        if (
          loan.loan_types?.requires_schedule === true &&
          !nextInstallmentByLoan[loan.id] &&
          loan.repayment_method === "fixed_installment"
        ) {
          warnings.push(`${emp.first_name} ${emp.last_name}: loan ${loan.loan_number} skipped — schedule required but none pending.`);
          loanSkipIssues.push({
            employee_id: emp.id,
            code: "RUN_LOAN_SCHEDULE_MISSING",
            message: `Loan ${loan.loan_number} skipped — loan type requires a repayment schedule and none is pending.`,
            details: { loan_id: loan.id, loan_number: loan.loan_number, reason: "schedule_missing" },
          });
          continue;
        }


        if (provisionalNet <= 0) {
          warnings.push(`${emp.first_name} ${emp.last_name}: loan ${loan.loan_number} skipped — no remaining net pay.`);
          loanSkipIssues.push({
            employee_id: emp.id,
            code: "RUN_LOAN_SKIP",
            message: `Loan ${loan.loan_number} skipped — no remaining net pay after prior deductions.`,
            details: { loan_id: loan.id, loan_number: loan.loan_number, reason: "no_remaining_net" },
          });
          break;
        }
        // Resolve per-loan-type deduction line key (falls back to generic)
        const ltCode: string | null = loan.loan_types?.salary_rule_code
          || (loan.loan_types?.code ? `loan_repayment_${String(loan.loan_types.code).toLowerCase()}` : null);
        const ruleCode = ltCode || "loan_repayment";

        // Compute the requested amount per repayment method
        let wanted = 0;
        switch (loan.repayment_method) {
          case "fixed_installment": {
            const sched = nextInstallmentByLoan[loan.id];
            wanted = sched
              ? Math.max(sched.scheduled_amount - sched.paid_amount, 0)
              : 0; // installment was skipped or none pending → no deduction
            break;
          }
          case "percent_of_net": {
            const pct = Number(loan.repayment_percent || 0);
            wanted = Math.max((provisionalNet * pct) / 100, 0);
            break;
          }
          case "one_off_next_payroll": {
            wanted = Number(loan.outstanding_balance || 0);
            break;
          }
          case "fixed_amount":
          default: {
            wanted = Number(loan.monthly_deduction || 0);
            break;
          }
        }
        wanted = Math.min(wanted, Number(loan.outstanding_balance || 0));

        // Apply max_pct_of_net cap if set
        if (loan.max_pct_of_net != null) {
          const cap = (provisionalNet * Number(loan.max_pct_of_net)) / 100;
          if (wanted > cap) wanted = cap;
        }
        // Apply min_net_pay_floor (do not push net below floor)
        const floor = Number(loan.min_net_pay_floor || 0);
        const headroom = Math.max(provisionalNet - floor, 0);
        const deductionAmt = Math.min(wanted, headroom);

        if (deductionAmt > 0) {
          if (deductionAmt < wanted) {
            warnings.push(`${emp.first_name} ${emp.last_name}: loan ${loan.loan_number} partially recovered (${deductionAmt.toFixed(2)} of ${wanted.toFixed(2)}) to honor min-net-pay floor / cap.`);
            loanSkipIssues.push({
              employee_id: emp.id,
              code: "RUN_LOAN_PARTIAL",
              message: `Loan ${loan.loan_number} partially recovered: ${deductionAmt.toFixed(2)} of ${wanted.toFixed(2)} to honor min-net-pay floor / cap.`,
              details: { loan_id: loan.id, loan_number: loan.loan_number, wanted, applied: deductionAmt, reason: "floor_or_cap" },
            });
          }
          provisionalNet -= deductionAmt;
          deductionsDetail[ruleCode] = (deductionsDetail[ruleCode] || 0) + deductionAmt;
          loanDeductionsToRecord.push({ loan_id: loan.id, employee_id: emp.id, amount: deductionAmt, rule_code: ruleCode });
        } else if (wanted > 0) {
          // wanted > 0 but blocked by floor/cap → record as skip
          warnings.push(`${emp.first_name} ${emp.last_name}: loan ${loan.loan_number} skipped — min-net-pay floor / cap would be breached.`);
          loanSkipIssues.push({
            employee_id: emp.id,
            code: "RUN_LOAN_SKIP",
            message: `Loan ${loan.loan_number} skipped — min-net-pay floor / cap would be breached.`,
            details: { loan_id: loan.id, loan_number: loan.loan_number, wanted, reason: "floor_or_cap" },
          });
        }
      }

      // ─── Employee advance recovery (after loans, before garnishments) ───
      // Honors min_net_floor per advance. Lump-sum recovers the full outstanding
      // amount in this run; installment mode recovers `installment_amount`
      // (falling back to amount/installment_count when not explicitly set).
      const empAdvances = advancesByEmployee[emp.id] || [];
      for (const adv of empAdvances) {
        if (provisionalNet <= 0) {
          warnings.push(`${emp.first_name} ${emp.last_name}: advance ${adv.id.slice(0, 8)} skipped — no remaining net pay.`);
          continue;
        }
        const wantedRaw = adv.recovery_method === "installments"
          ? Number(adv.installment_amount || (Number(adv.amount) / Math.max(1, Number(adv.installment_count || 1))))
          : Number(adv.outstanding);
        const wanted = Math.min(wantedRaw, Number(adv.outstanding));
        const floor = Number(adv.min_net_floor || 0);
        const headroom = Math.max(provisionalNet - floor, 0);
        const deductionAmt = Math.round(Math.min(wanted, headroom) * 100) / 100;
        if (deductionAmt <= 0) {
          warnings.push(`${emp.first_name} ${emp.last_name}: advance ${adv.id.slice(0, 8)} skipped — min-net-pay floor would be breached.`);
          continue;
        }
        if (deductionAmt < wanted) {
          warnings.push(`${emp.first_name} ${emp.last_name}: advance ${adv.id.slice(0, 8)} partially recovered (${deductionAmt.toFixed(2)} of ${wanted.toFixed(2)}) to honor min-net-pay floor.`);
        }
        provisionalNet -= deductionAmt;
        deductionsDetail["advance_recovery"] = (deductionsDetail["advance_recovery"] || 0) + deductionAmt;
        adv.outstanding = Math.max(0, Number(adv.outstanding) - deductionAmt);
        advanceRecoveriesToRecord.push({
          advance_id: adv.id,
          employee_id: emp.id,
          amount: deductionAmt,
        });
      }

      // ─── Turn C: legal orders / garnishments ───
      // Delegates all priority, cap, protected-earnings, effective-window and
      // remaining-balance math to the canonical shared garnishment engine.
      const garnishmentLineMeta: Array<{ id: string; code: string; label: string; amount: number }> = [];
      // P1: Employer admin fees per garnishment order, aggregated by
      // employer_fee_account_role (defaults to "garnishment_admin_fee").
      // Emitted later as employer_contribution payslip lines so
      // post-payroll-gl books DR <role>_employer_expense / CR <role>_payable
      // and payroll_liabilities tracks remittance like any other employer line.
      const employerFeeByRole: Record<string, { amount: number; orderIds: string[] }> = {};
      {
        const preGarnDeductions = Object.values(deductionsDetail).reduce((s, v) => s + v, 0);
        const garns = runTypePolicy.applies_garnishments
          ? ((garnishmentsByEmployee[emp.id] || []) as GarnishmentOrder[]).map((g) => ({
              ...g,
              carry_forward_amount: pendingCfByGarn[g.id]?.totalPending || 0,
            }))
          : [];
        const computedGarnishments = computeGarnishments({
          gross: grossPay,
          preGarnishmentDeductions: preGarnDeductions,
          orders: garns,
          policy: garnPolicy,
          kindDefaults: garnKindDefaults,
          period_start: pay_period_start,
          period_end: pay_period_end,
        });

        // Observability: orders supplied but engine withheld nothing.
        // Silent drops here previously hid a policy-fraction misconfiguration
        // for weeks. Surface as a first-class run issue so it can never
        // happen invisibly again.
        if (garns.length > 0 && computedGarnishments.totalGarnished === 0) {
          garnishmentZeroIssues.push({
            employee_id: emp.id,
            order_ids: garns.map((g) => g.id),
            order_count: garns.length,
            disposable: computedGarnishments.disposable,
            gross: grossPay,
            pre_garnishment_deductions: preGarnDeductions,
            aggregate_cap_pct: (garnPolicy?.aggregate_cap_pct ?? null) as number | null,
            min_take_home_pct: (garnPolicy?.min_take_home_pct ?? null) as number | null,
            min_take_home_amount: (garnPolicy?.min_take_home_amount ?? null) as number | null,
          });
        }

        for (const applied of computedGarnishments.applied) {
          const g = garns.find((order) => order.id === applied.id);
          if (!g) continue;
          const amt = applied.amount;
          const key = applied.code;
          deductionsDetail[key] = (deductionsDetail[key] || 0) + amt;
          garnishmentLineMeta.push({
            id: g.id,
            code: key,
            label: applied.label,
            amount: amt,
          });
          garnishmentsApplied.push({ id: g.id, amount: amt, employee_id: emp.id });

          // P6: record residual shortfall + roll prior carry-forward forward.
          const shortfall = applied.shortfall_amount;
          const prior = pendingCfByGarn[g.id];
          if (prior && prior.ids.length > 0) {
            // We attempted to recover prior shortfall this period; collapse the
            // prior rows into the new residual (or close them out if fully paid).
            cfConsumedIds.push(...prior.ids);
            prior.totalPending = 0;
            prior.ids = [];
          }
          if (!dry_run && shortfall > 0) {
            cfInserts.push({
              organization_id,
              business_id: business_id || null,
              garnishment_id: g.id,
              employee_id: emp.id,
              source_payroll_run_id: payrollRun.id,
              source_period_end: pay_period_end,
              requested_amount: applied.requested_amount,
              applied_amount: amt,
              shortfall_amount: shortfall,
              reason_code: applied.shortfall_reason ?? "disposable_exhausted",
            });
          }

          // P1: employer admin fee — only when the order actually withheld.
          // Fee is an *employer* cost (DR expense, CR payable). It never
          // touches disposable income or the aggregate cap.
          if (applied.employer_fee_amount > 0) {
            const fee = applied.employer_fee_amount;
            const role = (applied.employer_fee_account_role && String(applied.employer_fee_account_role).trim())
              || "garnishment_admin_fee";
            const slot = (employerFeeByRole[role] ||= { amount: 0, orderIds: [] });
            slot.amount = Math.round((slot.amount + fee) * 100) / 100;
            slot.orderIds.push(g.id);
          }
        }
      }

      // ─── Turn C: pending expense reimbursements (non-taxable add-back) ───
      const reimbursementLineMeta: Array<{ id: string; label: string; amount: number }> = [];
      let reimbursementTotal = 0;
      for (const r of (reimbursementsByEmployee[emp.id] || [])) {
        const amt = Math.round(Number(r.amount || 0) * 100) / 100;
        if (amt <= 0) continue;
        reimbursementTotal += amt;
        reimbursementLineMeta.push({
          id: r.id,
          label: r.description ? `Reimbursement: ${r.description}` : "Expense reimbursement",
          amount: amt,
        });
        reimbursementsConsumed.push({ id: r.id, employee_id: emp.id });
      }

      // ─── Turn D: custom deductions (Slice 2) ───
      // Applied AFTER loans/advances/garnishments/reimbursements. Reads
      // `deductionsDetail` totals-so-far to project current net and
      // respects each assignment's `min_net_floor` and `cumulative_cap`.
      const customDeductionLineMeta: Array<{
        assignment_id: string;
        type_id: string;
        scheme_component_id: string | null;
        code: string;
        label: string;
        amount: number;
        is_employer_contribution: boolean;
        payslip_group: string;
        sort_order: number;
        gl_liability_account_id: string | null;
        gl_expense_account_id: string | null;
        payroll_rule_code: string | null;
      }> = [];
      let customEmployeeDeductionTotal = 0;
      let customEmployerContributionTotal = 0;
      const empCustom = customDeductionsByEmployee[emp.id] || [];
      // Deterministic order: sort_order asc, then code
      empCustom.sort((a, b) => {
        const so = (a.deduction_type?.sort_order ?? 100) - (b.deduction_type?.sort_order ?? 100);
        if (so !== 0) return so;
        return String(a.deduction_type?.code || "").localeCompare(String(b.deduction_type?.code || ""));
      });
      const runningEmpDeductions = () =>
        Object.values(deductionsDetail).reduce((s: number, v: any) => s + Number(v || 0), 0)
        + customEmployeeDeductionTotal;
      for (const a of empCustom) {
        const t = a.deduction_type;
        if (!t) continue;
        // Reject pre_tax loudly: PAYE has already been computed above.
        if (t.tax_treatment === "pre_tax") {
          ruleConfigIssues.push({
            severity: "warning",
            employee_id: emp.id,
            code: "CUSTOM_DEDUCTION_PRE_TAX_UNSUPPORTED",
            message: `Custom deduction "${t.label}" (${t.code}) is pre_tax; engine currently applies pre_tax after PAYE. Switch to post_tax or wait for engine support.`,
            details: { assignment_id: a.id, deduction_type_id: t.id },
          });
          continue;
        }
        // Compute per method
        let raw = 0;
        if (t.computation_method === "flat_amount") {
          raw = Number(a.amount_override ?? (t.parameters as any)?.amount ?? 0);
        } else if (t.computation_method === "percentage_of_gross") {
          const rate = Number(a.rate_override ?? (t.parameters as any)?.rate ?? 0);
          raw = grossPay * rate;
        } else if (t.computation_method === "percentage_of_basic") {
          const rate = Number(a.rate_override ?? (t.parameters as any)?.rate ?? 0);
          raw = (Number(emp.basic_salary) || 0) * rate;
        } else {
          ruleConfigIssues.push({
            severity: "warning",
            employee_id: emp.id,
            code: "CUSTOM_DEDUCTION_METHOD_UNSUPPORTED",
            message: `Custom deduction "${t.label}" (${t.code}) uses unsupported method "${t.computation_method}".`,
            details: { assignment_id: a.id },
          });
          continue;
        }
        let amt = Math.max(0, Math.round(raw * 100) / 100);
        if (amt <= 0) continue;

        // Cumulative cap
        if (a.cumulative_cap != null) {
          const remaining = Number(a.cumulative_cap) - Number(a.cumulative_recovered || 0);
          if (remaining <= 0) continue;
          amt = Math.min(amt, Math.round(remaining * 100) / 100);
        }

        // Min-net floor (only for employee deductions, not employer contributions)
        if (!t.is_employer_contribution) {
          const floor = a.min_net_floor != null ? Number(a.min_net_floor) : null;
          if (floor != null) {
            const projectedNet = grossPay - runningEmpDeductions() - amt;
            if (projectedNet < floor) {
              const reduceBy = floor - projectedNet;
              amt = Math.max(0, Math.round((amt - reduceBy) * 100) / 100);
              if (amt <= 0) continue;
            }
          }
        }

        if (t.is_employer_contribution) {
          customEmployerContributionTotal += amt;
        } else {
          customEmployeeDeductionTotal += amt;
        }
        customDeductionLineMeta.push({
          assignment_id: a.id,
          type_id: t.id,
          scheme_component_id: t.scheme_component_id ?? null,
          code: t.code,
          label: t.label,
          amount: amt,
          is_employer_contribution: !!t.is_employer_contribution,
          payslip_group: t.payslip_group || "other_deductions",
          sort_order: t.sort_order ?? 100,
          gl_liability_account_id: t.gl_liability_account_id,
          gl_expense_account_id: t.gl_expense_account_id,
          payroll_rule_code: t.payroll_rule_code ?? null,
        });
        customDeductionsApplied.push({
          assignment_id: a.id,
          employee_id: emp.id,
          amount: amt,
          type_id: t.id,
        });
      }

      const empTotalDeductions = Object.values(deductionsDetail).reduce((s, v) => s + v, 0) + customEmployeeDeductionTotal;

      const empTotalEmployerContributions = Object.values(contributionsDetail).reduce((s, v) => s + v, 0) + customEmployerContributionTotal;
      const netPay = grossPay - empTotalDeductions;

      if (netPay < 0) {
        warnings.push(`${emp.first_name} ${emp.last_name} (${emp.employee_number}): negative net pay ${netPay.toFixed(2)}. Setting to 0.`);
      }
      const safeNetPay = Math.max(0, netPay);

      totalGross += grossPay;
      totalDeductions += empTotalDeductions;
      totalEmployerContributions += empTotalEmployerContributions;
      totalNet += safeNetPay;

      // Remap opaque `garnishment_<uuid>` keys to human labels for the
      // run-level summary so the preview shows e.g. "Child support (CASE-123)"
      // instead of a raw order id. The per-payslip deductions_detail still
      // uses the stable code for downstream joins.
      const garnLabelByCode = new Map(garnishmentLineMeta.map((g) => [g.code, g.label]));
      for (const [key, val] of Object.entries(deductionsDetail)) {
        const summaryKey = garnLabelByCode.get(key) ?? key;
        runDeductionsSummary[summaryKey] = (runDeductionsSummary[summaryKey] || 0) + val;
      }
      for (const [key, val] of Object.entries(contributionsDetail)) {
        runContributionsSummary[key] = (runContributionsSummary[key] || 0) + val;
      }
      for (const cd of customDeductionLineMeta) {
        const emittedCode = cd.payroll_rule_code ?? `custom_${cd.code}`;
        if (cd.is_employer_contribution) {
          runContributionsSummary[emittedCode] = (runContributionsSummary[emittedCode] || 0) + cd.amount;
        } else {
          runDeductionsSummary[emittedCode] = (runDeductionsSummary[emittedCode] || 0) + cd.amount;
        }
      }

      // ─── Build payslip_lines + payslip_inputs (AUTHORITATIVE) ───
      const lineRows: Array<Record<string, unknown>> = [];
      const inputRows: Array<Record<string, unknown>> = [];
      let seq = 0;
      // Phase C — earning-key → accounting_tag lookup for this employee.
      // Graph earnings supply their rule's tag; the fixed `overtime` bucket
      // falls back to the WET-level accounting_tag when the OT WET carries
      // one. Everything else stays untagged (NULL) and posts to the
      // generic salary_expense mapping in post-payroll-gl.
      const earnTag = graphEarningTagByEmployee[emp.id] || {};
      const wetOtTag =
        workEntryTypes.find((w) => w.code === "OT")?.accounting_tag ?? null;
      if (!earnTag["overtime"] && wetOtTag) earnTag["overtime"] = wetOtTag;
      const pushLine = (
        rule_code: string,
        category: string,
        lineLabel: string,
        employee_amount: number,
        employer_amount = 0,
        taxable = false,
        rule_type: string | null = null,
        source: Record<string, unknown> | null = null,
        // Phase 4 P1.1: optional statutory_rule_id for provenance/drill-down.
        // NULL for non-statutory lines (basic, allowances, loans, garnishments,
        // reimbursements). Set by statutory/contribution emitters below.
        statutory_rule_id: string | null = null,
        // Phase 4 P1.3: typed discriminated input_ref describing where this
        // line came from (contract, variable input, work entry, loan, ...).
        // Merged into `source.input_ref` — country-agnostic, mirrors the
        // doc-comment on public.payslip_lines.source.
        input_ref: InputRef | null = null,
        // Phase C: optional posting bucket copied onto payslip_lines.
        // NULL preserves legacy behaviour (posts to generic salary_expense).
        accounting_tag: string | null = null,
        // Enterprise statutory model: custom deductions and other pack-authored
        // byproducts can carry an explicit component id from their source row.
        // Prefer that durable identity over rule-code inference.
        explicit_scheme_component_id: string | null = null,
      ) => {
        if (!employee_amount && !employer_amount) return;
        const normalizedCategory = normalizePayslipLineCategory(category);
        const finalSource = input_ref ? withInputRef(source, input_ref) : source;
        // Statutory Scheme model: structural stamp for return generators,
        // GL, dashboards. NULL for non-statutory lines (earnings, loans,
        // garnishments, reimbursements) — they aren't part of any scheme.
        const scheme_component_id = explicit_scheme_component_id ?? resolveSchemeComponentId(
          empCountry,
          rule_code,
          Number(employee_amount) || 0,
          Number(employer_amount) || 0,
        );
        lineRows.push({
          rule_code,
          rule_type,
          category: normalizedCategory,
          label: lineLabel,
          sequence: seq++,
          employee_amount,
          employer_amount,
          taxable,
          source: normalizedCategory === category
            ? finalSource
            : {
                ...(finalSource || {}),
                original_category: category,
                normalized_category: normalizedCategory,
              },
          statutory_rule_id,
          accounting_tag,
          scheme_component_id,
        });
      };


      // Earnings
      if (basicSalary > 0) pushLine("basic", "earning", "Basic Salary", basicSalary, 0, true, "earning", null, null, { kind: "contract", code: "basic", component: "basic", contract_id: (emp as any).active_contract_id ?? null, label: "Employment contract — basic" }, earnTag["basic"] ?? null);
      if (housingAllowance > 0) pushLine("housing_allowance", "earning", "Housing Allowance", housingAllowance, 0, true, "earning", null, null, { kind: "contract", code: "housing_allowance", component: "housing", contract_id: (emp as any).active_contract_id ?? null, label: "Employment contract — housing" }, earnTag["housing_allowance"] ?? null);
      if (transportAllowance > 0) pushLine("transport_allowance", "earning", "Transport Allowance", transportAllowance, 0, true, "earning", null, null, { kind: "contract", code: "transport_allowance", component: "transport", contract_id: (emp as any).active_contract_id ?? null, label: "Employment contract — transport" }, earnTag["transport_allowance"] ?? null);
      for (const [k, v] of Object.entries(otherEarnings)) {
        const amt = Number(v) || 0;
        if (amt > 0) pushLine(k, "earning", k.replace(/_/g, " "), amt, 0, true, "earning", null, null, { kind: "salary_structure", code: k, label: `Salary structure — ${k.replace(/_/g, " ")}` }, earnTag[k] ?? null);
      }
      if (overtimePay > 0) pushLine("overtime", "earning", "Overtime", overtimePay, 0, true, "earning", null, null, { kind: "variable_input", code: "overtime", label: "Variable input — overtime" }, earnTag["overtime"] ?? null);
      if (bonus > 0) pushLine("bonus", "earning", "Bonus", bonus, 0, true, "earning", null, null, { kind: "variable_input", code: "bonus", label: "Variable input — bonus" }, earnTag["bonus"] ?? null);
      if (commission > 0) pushLine("commission", "earning", "Commission", commission, 0, true, "earning", null, null, { kind: "variable_input", code: "commission", label: "Variable input — commission" }, earnTag["commission"] ?? null);
      if (arrears > 0) pushLine("arrears", "earning", "Arrears", arrears, 0, true, "earning", null, null, { kind: "variable_input", code: "arrears", label: "Variable input — arrears" }, earnTag["arrears"] ?? null);
      for (const [k, v] of Object.entries(varEarnings)) {
        if (["employee_id", "overtime_pay", "bonus", "commission", "arrears"].includes(k)) continue;
        const amt = Number(v) || 0;
        if (amt > 0) pushLine(k, "earning", k.replace(/_/g, " "), amt, 0, true, "earning", null, null, { kind: "variable_input", code: k, label: `Variable input — ${k.replace(/_/g, " ")}` });
      }
      if (leaveDeduction > 0) {
        pushLine("unpaid_leave", "deduction", "Unpaid Leave Deduction", leaveDeduction, 0, false, "leave_deduction", { unpaid_leave_days: unpaidLeaveDays }, null, { kind: "leave_request", code: "unpaid_leave", days: unpaidLeaveDays, label: "Unpaid leave days" });
      }
      // Wave 4: termination payouts as one-off taxable earnings.
      for (const tp of terminationPayoutLines) {
        pushLine(tp.kind, "earning", tp.label, tp.amount, 0, true, "termination_payout", { days_paid: tp.days, notes: tp.notes }, null, { kind: "termination_payout", code: tp.kind, days: tp.days, pending_payout_id: (tp as any).pending_payout_id ?? null, label: tp.label });
      }

      // Statutory + dynamic deductions / employer contributions.
      // CRITICAL: line `rule_code` MUST be the per-rule stable code (PAYE,
      // NSSF, SHIF, AHL, NHIF...). It MUST NOT be `rule_type` — multiple
      // distinct localization rules share rule_type='statutory_deduction',
      // so using rule_type as the key collapses them into one bucket on
      // payslips, GL postings, and remittance reports.
      const codeFromRule = (r: PayrollRule | undefined, fallback: string): string =>
        (r?.rule_code && String(r.rule_code).trim())
          || (r?.rule_name ? r.rule_name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_+|_+$)/g, "") : "")
          || fallback;

      const bracketTracesByRuleName: Record<string, BracketTrace> =
        ((emp as any).__bracket_traces_by_rule_name || {}) as Record<string, BracketTrace>;

      for (const [ruleName, amt] of Object.entries(deductionsDetail)) {
        if (!amt) continue;
        if (ruleName.startsWith("garnishment_")) continue; // emitted separately below
        const statRule = statutoryRuleByName[ruleName];
        const isStatutory = !!statRule;
        const cat = ruleName === "loan_repayment"
          ? "loan_repayment"
          : ruleName.startsWith("benefit_")
            ? "benefit"
            : isStatutory
              ? "statutory_employee"
              : "deduction";
        const code = isStatutory ? codeFromRule(statRule, ruleName) : ruleName;
        const ref: InputRef = isStatutory
          ? { kind: "statutory_rule", code, statutory_rule_id: statRule?.id ?? null, pack_version_id: (statRule as any)?.pack_version_id ?? null, rule_code: code, label: `Statutory rule — ${code}` }
          : ruleName === "loan_repayment"
            ? { kind: "loan", code: "loan_repayment", label: "Loan repayment" }
            : ruleName.startsWith("benefit_")
              ? { kind: "benefit", code: ruleName, label: `Benefit — ${ruleName.replace(/^benefit_/, "")}` }
              : { kind: "payslip_input", code: ruleName, label: ruleName };
        // Attach bracket / relief explainer for bracket_progressive lines
        // (PAYE and any other income_tax rule). The PDF renderer reads
        // `source.bracket_breakdown` via adaptBracketBreakdown; we also
        // ship taxable_base_components + relief lines so accountants can
        // see the full build-up. Non-tax lines keep source=null.
        let lineSource: Record<string, unknown> | null = null;
        const trace = bracketTracesByRuleName[ruleName];
        if (trace) {
          const bracketBreakdown = (trace.tiers || []).map((t) => ({
            from: t.lower,
            to: t.upper,
            rate: t.rate_pct,
            base: t.slab,
            amount: t.tax,
            side: "employee" as const,
          }));
          lineSource = {
            bracket_breakdown: bracketBreakdown,
            taxable_base: trace.income,
            taxable_base_components: (trace as any).taxable_base_components ?? null,
            gross_tax: trace.gross_tax,
            personal_relief: trace.personal_relief,
            insurance_relief: trace.insurance_relief,
            final_tax: trace.final_tax,
            legal_basis: (statRule?.parameters as any)?.legal_basis ?? null,
          };
        }
        pushLine(code, cat, ruleName, Number(amt), 0, false, statRule?.rule_type || ruleName, lineSource, statRule?.id ?? null, ref);
      }
      // ADR-0062: emit `personal_relief` / `insurance_relief` payslip_lines
      // independently of the deductionsDetail walk. Statutory certificates
      // (P9A, and any future country's annual employee statement) resolve
      // these figures ONLY from payslip_lines per ADR-0061 — so they must
      // exist whenever the progressive tax rule reported a non-zero relief,
      // regardless of whether the tax-line loop above had a matching
      // bracket trace keyed by rule_name. Country-agnostic: sourced purely
      // from what the progressive rule wrote into `bracketTracesByRuleName`.
      // Positive amounts, category='relief', informational — never enter
      // deduction totals. Aggregates across multiple progressive rules if
      // a country ever ships more than one.
      {
        let personalReliefSum = 0;
        let insuranceReliefSum = 0;
        let parentRuleCode: string | null = null;
        let parentStatutoryRuleId: string | null = null;
        let parentPackVersionId: string | null = null;
        for (const [rName, t] of Object.entries(bracketTracesByRuleName)) {
          const pr = Number((t as any)?.personal_relief) || 0;
          const ir = Number((t as any)?.insurance_relief) || 0;
          if (pr > 0 || ir > 0) {
            personalReliefSum += pr;
            insuranceReliefSum += ir;
            if (!parentRuleCode) {
              const parentRule = statutoryRuleByName[rName];
              parentRuleCode = codeFromRule(parentRule, rName);
              parentStatutoryRuleId = parentRule?.id ?? null;
              parentPackVersionId = (parentRule as any)?.pack_version_id ?? null;
            }
          }
        }
        if (personalReliefSum > 0) {
          pushLine(
            "personal_relief",
            "relief",
            "Personal Relief",
            Math.round(personalReliefSum * 100) / 100,
            0,
            false,
            "relief",
            { parent_rule_code: parentRuleCode, computed_from: "bracket_trace" },
            parentStatutoryRuleId,
            { kind: "statutory_rule", code: "personal_relief", statutory_rule_id: parentStatutoryRuleId, pack_version_id: parentPackVersionId, rule_code: "personal_relief", label: "Personal relief (informational)" },
          );
        }
        if (insuranceReliefSum > 0) {
          pushLine(
            "insurance_relief",
            "relief",
            "Insurance Relief",
            Math.round(insuranceReliefSum * 100) / 100,
            0,
            false,
            "relief",
            { parent_rule_code: parentRuleCode, computed_from: "bracket_trace" },
            parentStatutoryRuleId,
            { kind: "statutory_rule", code: "insurance_relief", statutory_rule_id: parentStatutoryRuleId, pack_version_id: parentPackVersionId, rule_code: "insurance_relief", label: "Insurance relief (informational)" },
          );
        }
      }

      // Turn C: garnishment lines (priority-ordered)
      for (const gl of garnishmentLineMeta) {
        pushLine(gl.code, "post_tax_deduction", gl.label, gl.amount, 0, false, "garnishment", { garnishment_id: gl.id }, null, { kind: "garnishment", code: gl.code, garnishment_id: gl.id, label: gl.label });
      }
      // Turn C: reimbursement lines (non-taxable earnings)
      for (const rl of reimbursementLineMeta) {
        pushLine(`reimbursement_${rl.id}`, "earning", rl.label, rl.amount, 0, false, "reimbursement", { expense_id: rl.id }, null, { kind: "reimbursement", code: `reimbursement_${rl.id}`, expense_id: rl.id, label: rl.label });
      }
      // Turn D: custom deduction lines (Slice 2 — post-tax only in this pass)
      for (const cd of customDeductionLineMeta) {
        // When the tenant's custom_deduction_types row carries a pack-declared
        // `payroll_rule_code`, emit the payslip line under that stable code so
        // localization pack return templates and pack tokens can bind to it
        // (e.g. Kenya NSSF Type-105 "nssf_voluntary" — NSSF_RET VOLUNTARY column).
        // Otherwise fall back to the engine-internal `custom_<code>` prefix so
        // legacy tenant-created deductions keep behaving byte-identically.
        const emittedCode = cd.payroll_rule_code ?? `custom_${cd.code}`;
        pushLine(
          emittedCode,
          cd.is_employer_contribution ? "employer_contribution" : "deduction",
          cd.label,
          cd.is_employer_contribution ? 0 : cd.amount,
          cd.is_employer_contribution ? cd.amount : 0,
          false,
          "custom_deduction",
          {
            source: "custom_deduction",
            assignment_id: cd.assignment_id,
            deduction_type_id: cd.type_id,
            gl_liability_account_id: cd.gl_liability_account_id,
            gl_expense_account_id: cd.gl_expense_account_id,
            payslip_group: cd.payslip_group,
            payroll_rule_code: cd.payroll_rule_code,
            scheme_component_id: cd.scheme_component_id,
          },
          null,
          { kind: "custom_deduction", code: emittedCode, assignment_id: cd.assignment_id, deduction_type_id: cd.type_id, label: cd.label },
          null,
          cd.scheme_component_id,
        );
      }
      // P1: Employer admin fees — one employer_contribution line per resolved
      // role. rule_code = role so post-payroll-gl looks up <role>_employer_expense
      // / <role>_payable mappings and payroll_liabilities tracks remittance.
      for (const [role, slot] of Object.entries(employerFeeByRole)) {
        if (slot.amount <= 0) continue;
        pushLine(
          role,
          "employer_contribution",
          `Garnishment admin fee (${slot.orderIds.length} order${slot.orderIds.length === 1 ? "" : "s"})`,
          0,
          slot.amount,
          false,
          "garnishment_admin_fee",
          { garnishment_ids: slot.orderIds },
          null,
          { kind: "benefit", code: role, label: "Garnishment admin fee" },
        );
        // Track in employer-contributions summary for the run-level totals.
        runContributionsSummary[role] = (runContributionsSummary[role] || 0) + slot.amount;
        totalEmployerContributions += slot.amount;
      }

      for (const [ruleName, amt] of Object.entries(contributionsDetail)) {
        if (!amt) continue;
        const statRule = statutoryRuleByName[ruleName];
        const isStatutory = !!statRule;
        const cat = isStatutory ? "statutory_employer" : "employer_contribution";
        const code = isStatutory ? codeFromRule(statRule, ruleName) : ruleName;
        const ref: InputRef = isStatutory
          ? { kind: "statutory_rule", code, statutory_rule_id: statRule?.id ?? null, pack_version_id: (statRule as any)?.pack_version_id ?? null, rule_code: code, label: `Statutory rule (employer) — ${code}` }
          : { kind: "benefit", code: ruleName, label: `Employer contribution — ${ruleName}` };
        pushLine(code, cat, `${ruleName} (employer)`, 0, Number(amt), false, statRule?.rule_type || ruleName, null, statRule?.id ?? null, ref);
      }



      // Inputs (provenance)
      if (attendance && attendance.daysPresent > 0) {
        inputRows.push({
          source: "attendance",
          label: "Attendance hours",
          quantity: Math.round(attendance.totalWorkedHours * 100) / 100,
          uom: "hours",
          metadata: { days_present: attendance.daysPresent, overtime_hours: attendance.totalOvertimeHours },
        });
      }
      if (unpaidLeaveDays > 0) {
        inputRows.push({
          source: "leave",
          label: "Unpaid leave",
          quantity: unpaidLeaveDays,
          uom: "days",
          amount: leaveDeduction,
        });
      }
      if (prorationFactor < 1) {
        inputRows.push({
          source: "contract",
          label: "Proration factor",
          quantity: prorationFactor,
          uom: "factor",
          metadata: {
            hire_date: emp.hire_date,
            termination_date: emp.termination_date,
            contract_basic: preProration.basic,
            contract_housing: preProration.housing,
            contract_transport: preProration.transport,
            contract_other: preProration.other,
          },
        });
      }
      if (overrideApplied) {
        inputRows.push({
          source: "override",
          label: "Proration override (full period)",
          quantity: 1,
          uom: "factor",
          metadata: {
            computed_factor: computedFactorBeforeOverride,
            reason: override!.reason || null,
            hire_date: emp.hire_date,
            termination_date: emp.termination_date,
          },
        });
      }

      // Phase 4 P1.3: write authoritative payslip_inputs rows for every
      // non-zero variable earning the operator entered. These rows make
      // payslip_inputs (not the engine's in-memory varEarnings map) the
      // single source of truth for "what input produced this line".
      // `payslip_line_id` is back-filled after the lines are inserted
      // (see the insert-flow `linesByEmpCode` block below).
      const pushVarInput = (code: string, amount: number, uom: string = "amount") => {
        if (!amount) return;
        inputRows.push({
          source: "variable_input",
          code,
          label: `Variable input — ${code.replace(/_/g, " ")}`,
          quantity: amount,
          uom,
          amount,
        });
      };
      if (overtimePay > 0) pushVarInput("overtime", overtimePay);
      if (bonus > 0) pushVarInput("bonus", bonus);
      if (commission > 0) pushVarInput("commission", commission);
      if (arrears > 0) pushVarInput("arrears", arrears);
      for (const [k, v] of Object.entries(varEarnings)) {
        if (["employee_id", "overtime_pay", "bonus", "commission", "arrears"].includes(k)) continue;
        const amt = Number(v) || 0;
        if (amt > 0) pushVarInput(k, amt);
      }


      // Turn C: reimbursements are post-deduction, non-taxable add-back to net + gross
      const storedGrossPay = grossPay + reimbursementTotal;
      const storedNetPay = safeNetPay + reimbursementTotal;
      if (reimbursementTotal > 0) {
        totalGross += reimbursementTotal;
        totalNet += reimbursementTotal;
      }

      // ─── Header ← Lines reconciliation (ADR-0058 payslip integrity) ───
      // The single source of truth for what an employee sees, what the GL
      // posts, and what statutory returns aggregate is `payslip_lines`.
      // Any header total we persist MUST equal the sum of the lines that
      // back it — otherwise a future engine path could (and historically
      // did, see PAY-0065 legal-order incident) grow a total via the
      // `deductionsDetail` dict without emitting a matching line.
      // We fail closed rather than silently persisting a divergent header.
      const linesEmpDeductions = lineRows
        .filter((l) => classifyPayslipLine(l as any) === "deduction")
        .reduce((s, l) => s + Number((l as any).employee_amount || 0), 0);
      const linesEmpEmployerContribs = lineRows
        .filter((l) => classifyPayslipLine(l as any) === "employer_contribution")
        .reduce((s, l) => s + Number((l as any).employer_amount || 0), 0);
      const linesEmpEarnings = lineRows
        .filter((l) => classifyPayslipLine(l as any) === "earning")
        .reduce((s, l) => s + Number((l as any).employee_amount || 0), 0);
      const roundCent = (n: number) => Math.round(n * 100) / 100;
      const empKey = `${emp.first_name} ${emp.last_name} (${emp.employee_number})`;
      if (Math.abs(roundCent(linesEmpDeductions) - roundCent(empTotalDeductions)) > 0.01) {
        throw new Error(
          `PAYSLIP_LINES_TOTAL_MISMATCH: ${empKey} header total_deductions=${roundCent(empTotalDeductions)} but sum(payslip_lines[deduction])=${roundCent(linesEmpDeductions)}. A deduction pipeline updated the dict without emitting a line, or vice versa.`,
        );
      }
      if (Math.abs(roundCent(linesEmpEmployerContribs) - roundCent(empTotalEmployerContributions)) > 0.01) {
        throw new Error(
          `PAYSLIP_LINES_TOTAL_MISMATCH: ${empKey} header employer_contributions=${roundCent(empTotalEmployerContributions)} but sum(payslip_lines[employer_contribution])=${roundCent(linesEmpEmployerContribs)}.`,
        );
      }
      if (Math.abs(roundCent(linesEmpEarnings) - roundCent(storedGrossPay)) > 0.01) {
        throw new Error(
          `PAYSLIP_LINES_TOTAL_MISMATCH: ${empKey} header gross_pay=${roundCent(storedGrossPay)} but sum(payslip_lines[earning])=${roundCent(linesEmpEarnings)}.`,
        );
      }

      payslipsData.push({
        employee_id: emp.id,
        organization_id,
        business_id: business_id || null,
        // Phase 4 P1.2c: header carries only universal totals + lineage.
        // Per-line decomposition (incl. basic, allowances, other earnings)
        // lives exclusively in payslip_lines — the single source of truth.
        // The three money totals below are DERIVED from `lineRows` (verified
        // by the reconciliation block above) so it is structurally
        // impossible for the header to disagree with its lines.
        gross_pay: roundCent(linesEmpEarnings),
        total_deductions: roundCent(linesEmpDeductions),
        // Preserve the historical clamp: only base earnings (linesEmpEarnings
        // minus the reimbursement passthrough) can be reduced to 0 by
        // deductions; reimbursements always pay out on top.
        net_pay: roundCent(
          Math.max(0, linesEmpEarnings - reimbursementTotal - linesEmpDeductions) + reimbursementTotal,
        ),
        taxable_income: finalTaxableBase,
        // Audit 2026-07-05 closeout — persist the base PAYE was computed
        // against + the gross tax before reliefs so reports/tax certificates
        // don't have to re-derive them from payslip_lines.source.
        taxable_base: finalTaxableBase,
        paye_before_relief: (() => {
          const traces = ((emp as any).__bracket_traces_by_rule_name || {}) as Record<string, any>;
          let sum = 0;
          for (const t of Object.values(traces)) {
            sum += Number((t as any)?.gross_tax || 0);
          }
          return sum > 0 ? Math.round(sum * 100) / 100 : null;
        })(),
        // Insert the header as a construction draft because Supabase REST
        // writes payslips and payslip_lines in separate database transactions.
        // The DB integrity trigger intentionally skips draft headers, then we
        // promote regular-run payslips to `pending` after authoritative lines
        // have been inserted below, causing the trigger to validate against the
        // completed line set. Do not insert non-draft here unless headers and
        // lines are persisted in the same SQL transaction.
        status: "draft",
        // Human-readable breakdown for reports/UI. Garnishment keys are
        // remapped from opaque `garnishment_<uuid>` codes to the resolved
        // order label ("Child support (CASE-…)") — the join key stays on
        // `payslip_lines.source.garnishment_id`.
        deductions_detail: (() => {
          const remapped: Record<string, number> = {};
          for (const [key, val] of Object.entries(deductionsDetail)) {
            const label = garnLabelByCode.get(key) ?? key;
            remapped[label] = (remapped[label] || 0) + Number(val || 0);
          }
          return remapped;
        })(),
        contributions_detail: contributionsDetail,
        unpaid_leave_days: unpaidLeaveDays,
        leave_deduction: leaveDeduction,
        // R3: stamp the immutable rule set used to compute this payslip.
        rule_set_id: employeeRuleSet?.id || null,
        rule_set_version: employeeRuleSet?.version || null,
        rule_set_hash: employeeRuleSet?.rule_hash || null,
        // Phase 4 P1.1: pack version that produced this payslip's statutory
        // amounts. Derived from the first statutory rule that carries a pack
        // link for the employee's country; NULL when no rule was attributable
        // (e.g. country with no installed pack — already a blocker upstream).
        pack_version_id: (empRules.find((r) => r.pack_version_id)?.pack_version_id) ?? null,
        // Preview fields (stripped before insert)
        _employee_name: (() => {
          const empName = `${emp.first_name || ""} ${emp.last_name || ""}`.trim();
          if (!empName || (/^[a-z0-9._-]+$/i.test(emp.first_name?.trim()) && /\d/.test(emp.first_name?.trim()))) {
            const profileName = emp.user_id ? profileNameMap[emp.user_id] : null;
            if (profileName) return profileName;
            return empName || `Employee ${emp.employee_number || emp.id.slice(0, 8)}`;
          }
          return empName;
        })(),
        _employee_number: emp.employee_number,
        _proration_factor: prorationFactor,
        _salary_source: salarySource,
        _lines: lineRows,
        _inputs: inputRows,
      });
      phase("employee-loop-end", { emp: emp.employee_number, empMs: Date.now() - _empPhaseStart });
      // Reflect this employee as *completed* in the progress bar.
      await heartbeat("computing", { current: payslipsData.length, total: employees.length });
    }

    // ─── Dry-run: return preview without persisting ───
    if (dry_run) {
      phase("dry-run-serializing", { payslips: payslipsData.length });
      // Per-employee bracket trace lets the UI explain exactly what `income`
      // PAYE (or any bracket_progressive tax) was computed against, plus the
      // tier-by-tier slab/tax. Mirrors the `payroll_run_issues` rows we
      // persist for non-dry-run runs.
      const bracket_trace = bracketTraceSink.map(({ employee_id, traces }) => {
        const ps = payslipsData.find((p: any) => p.employee_id === employee_id);
        return {
          employee_id,
          employee_name: ps?._employee_name || null,
          employee_number: ps?._employee_number || null,
          gross_pay: ps?.gross_pay ?? null,
          taxable_income: ps?.taxable_income ?? null,
          traces,
        };
      });
      const _dryPayload = JSON.stringify({
        dry_run: true,
        employee_count: payslipsData.length,
        total_gross: totalGross,
        total_net: totalNet,
        total_deductions: totalDeductions,
        total_employer_contributions: totalEmployerContributions,
        deductions_summary: runDeductionsSummary,
        contributions_summary: runContributionsSummary,
        payslips: payslipsData,
        warnings,
        bracket_trace,
      });
      phase("dry-run-return", { bytes: _dryPayload.length });
      return new Response(_dryPayload, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // ─── Insert payroll run (generic totals only) ───
    const payrollRunInsert = () => ({
        organization_id,
        business_id: business_id || null,
        payroll_number: finalPayrollNumber,
        pay_period_start,
        pay_period_end,
        payment_date: (body as PayrollRequest).payment_date || null,
        status: "draft",
        total_gross: totalGross,
        total_net: totalNet,
        total_other_deductions: totalDeductions,
        employee_count: payslipsData.length,
        created_by: userId,
        deductions_summary: runDeductionsSummary,
        contributions_summary: runContributionsSummary,
        total_employer_contributions: totalEmployerContributions,
        run_type: runType,
        parent_run_id: parentRunId,
        period_id: resolvedPeriodId,
        run_type_policy_snapshot: runTypePolicy,

      });

    let payrollRun: any = null;
    let prError: any = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await supabaseAdmin
        .from("payroll_runs")
        .insert(payrollRunInsert())
        .select()
        .single();
      payrollRun = result.data;
      prError = result.error;
      if (!prError) break;
      if (isDuplicatePayrollNumber(prError)) {
        const { data: nextNumber, error: numErr } = await supabaseAdmin.rpc("get_next_payroll_number", {
          _org_id: organization_id,
        });
        if (numErr) throw numErr;
        finalPayrollNumber = nextNumber || `PAY-${Date.now()}`;
        continue;
      }
      if (isDuplicateRegularPeriod(prError) && runType === "regular") {
        const { data: existingRegular } = await supabaseAdmin
          .from("payroll_runs")
          .select("*")
          .eq("organization_id", organization_id)
          .eq("business_id", business_id || null)
          .eq("pay_period_start", pay_period_start)
          .eq("pay_period_end", pay_period_end)
          .eq("run_type", "regular")
          .neq("status", "deleted")
          .maybeSingle();
        if (existingRegular) {
          return new Response(JSON.stringify({
            code: "REGULAR_RUN_EXISTS",
            message: `A regular payroll run already exists for this period (${existingRegular.payroll_number}, status: ${existingRegular.status}).`,
            payroll_run: existingRegular,
            employee_count: existingRegular.employee_count ?? 0,
            warnings: [],
            reused: true,
            existing_run_id: existingRegular.id,
            existing_payroll_number: existingRegular.payroll_number,
            existing_status: existingRegular.status,
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      break;
    }

    if (prError) throw prError;

    // Surface skipped statutory rules as warning issues so the run details
    // panel shows them instead of failing silently with zero deductions.
    if (skippedRuleSink.size > 0) {
      const issueRows = Array.from(skippedRuleSink).map((key) => {
        const [ruleId, ruleType, ruleName, method] = key.split("|");
        return {
          organization_id,
          business_id: business_id || null,
          payroll_run_id: payrollRun.id,
          employee_id: null,
          code: "RULE_SKIPPED_UNKNOWN_METHOD",
          severity: "warning",
          message: `Statutory rule "${ruleName}" (${ruleType}) was skipped — computation method "${method}" is not recognised. Set computation_method to one of: bracket_progressive, tiered_brackets, percentage_of_gross, graduated_table, flat_amount, per_employee_flat.`,
          details: { rule_id: ruleId, rule_type: ruleType, rule_name: ruleName, computation_method: method },
        };
      });
      await supabaseAdmin.from("payroll_run_issues").insert(issueRows);
    }

    // R1/R5/R6: flush rule-configuration issues collected during rule load.
    if (ruleConfigIssues.length > 0) {
      const cfgRows = ruleConfigIssues.map((iss) => ({
        organization_id,
        business_id: business_id || null,
        payroll_run_id: payrollRun.id,
        employee_id: iss.employee_id,
        code: iss.code,
        severity: iss.severity,
        message: iss.message,
        details: iss.details,
      }));
      for (let i = 0; i < cfgRows.length; i += 500) {
        await supabaseAdmin.from("payroll_run_issues").insert(cfgRows.slice(i, i + 500));
      }
    }

    // Per-employee bracket-progressive trace is kept in the dry-run response
    // payload (bracket_trace) and committed-run JE narrations for auditability,
    // but NOT persisted as run_issues. Surfacing tier-by-tier math as an "info"
    // warning trains accountants to ignore the issues panel; professional
    // payroll systems only flag items that need human action. The trace stays
    // available for support/debug via the response and the JE detail view.


    // Stage 7: blocker rows for employees skipped due to unapproved/missing timesheets.
    if (skippedEmployees.size > 0) {
      const blockerRows = Array.from(skippedEmployees.entries()).map(([empId, reason]) => ({
        organization_id,
        business_id: business_id || null,
        payroll_run_id: payrollRun.id,
        employee_id: empId,
        code: reason.code,
        severity: "blocker",
        message: reason.message,
        details: reason.details || {},
      }));
      await supabaseAdmin.from("payroll_run_issues").insert(blockerRows);
    }

    // Loan skip / partial recovery → warning run_issues for visibility.
    if (loanSkipIssues.length > 0) {
      const rows = loanSkipIssues.map((iss) => ({
        organization_id,
        business_id: business_id || null,
        payroll_run_id: payrollRun.id,
        employee_id: iss.employee_id,
        code: iss.code,
        severity: "warning",
        message: iss.message,
        details: iss.details,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await supabaseAdmin.from("payroll_run_issues").insert(rows.slice(i, i + 500));
      }
    }

    // Garnishment engine withheld nothing despite active in-window orders.
    // Emit a warning per employee so the run details panel names the reason
    // (floor breached / cap exhausted / policy misconfig) instead of silently
    // producing a payslip without the ordered deduction.
    if (garnishmentZeroIssues.length > 0) {
      const rows = garnishmentZeroIssues.map((iss) => ({
        organization_id,
        business_id: business_id || null,
        payroll_run_id: payrollRun.id,
        employee_id: iss.employee_id,
        code: "GARNISHMENT_WITHHELD_ZERO",
        severity: "warning",
        message: `${iss.order_count} active legal order${iss.order_count === 1 ? "" : "s"} withheld nothing this period — check garnishment policy (protected-earnings floor / aggregate cap) or the employee's disposable income.`,
        details: iss,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await supabaseAdmin.from("payroll_run_issues").insert(rows.slice(i, i + 500));
      }
    }


    // Pre-existing user-recorded skip overrides for this run → info-level visibility.
    {
      const { data: skipOverrides } = await supabaseAdmin
        .from("payroll_run_loan_skip_overrides")
        .select("id, employee_id, loan_id, schedule_id, reason")
        .eq("payroll_run_id", payrollRun.id);
      if (skipOverrides && skipOverrides.length > 0) {
        const rows = skipOverrides.map((o: any) => ({
          organization_id,
          business_id: business_id || null,
          payroll_run_id: payrollRun.id,
          employee_id: o.employee_id,
          code: "RUN_LOAN_SKIP_OVERRIDE",
          severity: "warning",
          message: `Loan repayment skip override applied${o.reason ? `: ${o.reason}` : ""}.`,
          details: { override_id: o.id, loan_id: o.loan_id, schedule_id: o.schedule_id, reason: o.reason },
        }));
        await supabaseAdmin.from("payroll_run_issues").insert(rows);
      }
    }



    // ─── Insert payslips (strip internal preview fields) ───
    const payslipsToInsert = payslipsData.map((ps: any) => {
      const { _employee_name, _employee_number, _proration_factor, _salary_source, _lines, _inputs, ...payslipData } = ps;
      return { ...payslipData, payroll_run_id: payrollRun.id };
    });

    // ───────────────────────────────────────────────────────────────────────
    // Phase 3.4 — Correction Delta Engine
    //
    // For runType='correction' with a parent_run_id, we DO NOT persist the
    // recomputed payslip as-is. Instead we subtract the parent run's posted
    // values from the freshly computed values and persist only the signed
    // delta (gross / deductions / net / lines), linked to the parent via
    // payslips.retro_of_payslip_id.
    //
    // Why: the YTD trigger (`trg_payslip_lines_ytd`) sums every payslip_line
    // additively. If we inserted a full recomputed payslip on a correction
    // run, every YTD aggregate would double-count (parent + correction).
    // Signed deltas leave YTD totals at the corrected value without touching
    // the original posted payslip.
    //
    // Zero-delta employees are dropped with a `RUN_NO_CORRECTION_DELTA` info
    // issue so accountants can see "we re-checked and nothing changed".
    // ───────────────────────────────────────────────────────────────────────
    // Phase 4 P1.2c: header-level numeric deltas are restricted to the
    // four universal totals. Per-rule_code deltas continue to flow
    // exclusively through the payslip_lines delta path below
    // (correctionParentLinesByEmployee), so no country-specific column
    // appears in this projection.
    const NUMERIC_DELTA_FIELDS = [
      "gross_pay", "total_deductions", "net_pay", "taxable_income",
    ] as const;
    const correctionZeroDeltaEmployees: string[] = [];
    const correctionParentPayslipByEmployee = new Map<string, any>();
    const correctionParentLinesByEmployee = new Map<string, any[]>();

    if (runType === "correction" && parentRunId) {
      const empIds = payslipsData.map((p: any) => p.employee_id);
      const { data: parentPayslips, error: pPsErr } = await supabaseAdmin
        .from("payslips")
        .select("id, employee_id, " + NUMERIC_DELTA_FIELDS.join(", "))
        .eq("payroll_run_id", parentRunId)
        .in("employee_id", empIds);
      if (pPsErr) {
        await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
        throw new Error(`Correction: failed to load parent payslips — ${pPsErr.message}`);
      }
      for (const pp of (parentPayslips || [])) {
        correctionParentPayslipByEmployee.set(pp.employee_id, pp);
      }
      const parentIds = (parentPayslips || []).map((p: any) => p.id);
      if (parentIds.length > 0) {
        const { data: parentLines, error: pLnErr } = await supabaseAdmin
          .from("payslip_lines")
          .select("payslip_id, employee_id, rule_code, rule_type, category, label, sequence, employee_amount, employer_amount, taxable, accounting_tag")
          .in("payslip_id", parentIds);
        if (pLnErr) {
          await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
          throw new Error(`Correction: failed to load parent payslip lines — ${pLnErr.message}`);
        }
        for (const ln of (parentLines || [])) {
          const arr = correctionParentLinesByEmployee.get(ln.employee_id) || [];
          arr.push(ln);
          correctionParentLinesByEmployee.set(ln.employee_id, arr);
        }
      }

      // Mutate each row to be a signed delta + retro link; drop zero-deltas.
      const kept: any[] = [];
      for (const row of payslipsToInsert) {
        const parent = correctionParentPayslipByEmployee.get(row.employee_id);
        if (!parent) {
          // Should be impossible: resolver with population_source='parent_run'
          // guarantees the employee was in the parent run.
          correctionZeroDeltaEmployees.push(row.employee_id);
          continue;
        }
        let anyNonZero = false;
        for (const f of NUMERIC_DELTA_FIELDS) {
          const newV = Number(row[f] ?? 0);
          const oldV = Number(parent[f] ?? 0);
          const delta = Math.round((newV - oldV) * 100) / 100;
          row[f] = delta;
          if (Math.abs(delta) >= 0.005) anyNonZero = true;
        }
        row.retro_of_payslip_id = parent.id;
        // Mark status so UI / reporting can distinguish delta payslips.
        if (!row.status || row.status === "pending") row.status = "draft";
        if (!anyNonZero) {
          correctionZeroDeltaEmployees.push(row.employee_id);
          continue;
        }
        kept.push(row);
      }
      // Replace the to-insert list with surviving delta rows.
      payslipsToInsert.length = 0;
      payslipsToInsert.push(...kept);
    }

    // Phase 3.4-followup #1 — record a `RUN_NO_CORRECTION_DELTA` info issue
    // per employee that had a parent payslip but whose recomputation netted
    // to zero across every numeric field. These employees were dropped from
    // the run (no zero-value payslip is inserted); the issue row is the
    // audit trail that we did re-check them.
    if (correctionZeroDeltaEmployees.length > 0) {
      const noDeltaRows = correctionZeroDeltaEmployees.map((empId) => ({
        organization_id,
        business_id: business_id || null,
        payroll_run_id: payrollRun.id,
        employee_id: empId,
        code: "RUN_NO_CORRECTION_DELTA",
        severity: "info",
        message: "Correction recomputation produced no change vs. parent run.",
        details: { parent_run_id: parentRunId },
      }));
      for (let i = 0; i < noDeltaRows.length; i += 500) {
        await supabaseAdmin
          .from("payroll_run_issues")
          .insert(noDeltaRows.slice(i, i + 500));
      }
    }

    const { data: insertedPayslips, error: psError } = await supabaseAdmin
      .from("payslips")
      .insert(payslipsToInsert)
      .select("id, employee_id");

    if (psError) {
      await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
      throw psError;
    }

    // ─── Persist payslip_lines + payslip_inputs (AUTHORITATIVE — failure IS fatal) ───
    const psIdByEmployee = new Map<string, string>();
    for (const row of insertedPayslips || []) {
      psIdByEmployee.set(row.employee_id, row.id);
    }
    const allLineRows: any[] = [];
    const allInputRows: any[] = [];
    for (const ps of payslipsData as any[]) {
      const psId = psIdByEmployee.get(ps.employee_id);
      if (!psId) continue;
      for (const ln of (ps._lines || [])) {
        allLineRows.push(normalizePayslipLineRow({
          ...ln,
          payslip_id: psId,
          payroll_run_id: payrollRun.id,
          employee_id: ps.employee_id,
          organization_id,
          business_id: business_id || null,
          // R3: stamp every line with the rule set used to compute this payslip.
          rule_version_id: ps.rule_set_id || null,
          rule_version_hash: ps.rule_set_hash || null,
        }));
      }
      for (const inp of (ps._inputs || [])) {
        allInputRows.push({
          ...inp,
          payslip_id: psId,
          payroll_run_id: payrollRun.id,
          employee_id: ps.employee_id,
          organization_id,
          business_id: business_id || null,
        });
      }
    }
    if (allLineRows.length > 0) {
      // Phase 3.4: collapse correction line rows into per-(rule_code,category)
      // signed deltas against the parent run's lines for the same employee.
      if (runType === "correction" && parentRunId) {
        const newByEmp = new Map<string, any[]>();
        for (const ln of allLineRows) {
          const arr = newByEmp.get(ln.employee_id) || [];
          arr.push(ln);
          newByEmp.set(ln.employee_id, arr);
        }
        const deltaLineRows: any[] = [];
        for (const [empId, newLines] of newByEmp) {
          const parentLines = correctionParentLinesByEmployee.get(empId) || [];
          // Key by (rule_code, category) — `category` is an enum but compares as string.
          const keyOf = (l: any) => `${l.rule_code}|${l.category}`;
          const parentByKey = new Map<string, any>();
          for (const pl of parentLines) parentByKey.set(keyOf(pl), pl);
          const newByKey = new Map<string, any>();
          for (const nl of newLines) {
            // If multiple lines share the same (code, category) — collapse by sum
            // so the delta math matches what payslip-level totals say.
            const k = keyOf(nl);
            const existing = newByKey.get(k);
            if (existing) {
              existing.employee_amount = Number(existing.employee_amount || 0) + Number(nl.employee_amount || 0);
              existing.employer_amount = Number(existing.employer_amount || 0) + Number(nl.employer_amount || 0);
            } else {
              newByKey.set(k, { ...nl });
            }
          }
          const allKeys = new Set<string>([...parentByKey.keys(), ...newByKey.keys()]);
          for (const k of allKeys) {
            const nl = newByKey.get(k);
            const pl = parentByKey.get(k);
            const empDelta = Math.round(((Number(nl?.employee_amount || 0)) - (Number(pl?.employee_amount || 0))) * 100) / 100;
            const erDelta  = Math.round(((Number(nl?.employer_amount || 0)) - (Number(pl?.employer_amount || 0))) * 100) / 100;
            if (Math.abs(empDelta) < 0.005 && Math.abs(erDelta) < 0.005) continue;
            // Template: prefer the new line shape; fall back to parent shape for reversals.
            const template = nl || pl;
            deltaLineRows.push({
              ...template,
              employee_amount: empDelta,
              employer_amount: erDelta,
              source: { ...(template.source || {}), correction_of_run: parentRunId, delta: true },
            });
          }
        }
        // Re-key payslip_id for delta rows: psIdByEmployee was rebuilt off the
        // surviving delta payslips above, so this lookup is correct.
        const reKeyed: any[] = [];
        for (const dr of deltaLineRows) {
          const psId = psIdByEmployee.get(dr.employee_id);
          if (!psId) continue; // employee was zero-delta and dropped
          reKeyed.push(normalizePayslipLineRow({ ...dr, payslip_id: psId, payroll_run_id: payrollRun.id }));
        }
        allLineRows.length = 0;
        allLineRows.push(...reKeyed);
      }
    }
    if (allLineRows.length > 0) {
      const { data: insertedLines, error: lnErr } = await supabaseAdmin
        .from("payslip_lines")
        .insert(allLineRows)
        .select("id, payslip_id, rule_code, category");
      if (lnErr) {
        // Fatal — roll back payslips and payroll run
        console.error("[compute-payroll] payslip_lines insert FAILED (fatal):", lnErr.message);
        await supabaseAdmin.from("payslips").delete().eq("payroll_run_id", payrollRun.id);
        await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
        throw new Error(`Payroll rolled back: payslip_lines insert failed — ${lnErr.message}`);
      }
      // Phase 4 P1.3: backfill payslip_inputs.payslip_line_id by matching
      // (payslip_id, code) against the just-inserted lines. This makes
      // payslip_inputs the authoritative record of "what input produced
      // this line" — no more engine-only in-memory state.
      if (insertedLines && allInputRows.length > 0) {
        const lineIdByKey = new Map<string, string>();
        for (const ln of insertedLines) {
          lineIdByKey.set(`${ln.payslip_id}|${ln.rule_code}`, ln.id);
        }
        for (const ir of allInputRows) {
          const code = (ir as any).code;
          if (!code) continue;
          const lid = lineIdByKey.get(`${(ir as any).payslip_id}|${code}`);
          if (lid) (ir as any).payslip_line_id = lid;
        }
      }
    }

    // Finalize regular-run payslips only after payslip_lines exist. This is
    // the transaction-boundary bridge for the DB guard: the status transition
    // draft -> pending fires `payslips_totals_match_lines`, which now sees the
    // authoritative lines and rejects any header/line drift. Corrections remain
    // draft delta documents until their existing lifecycle advances them.
    if (runType !== "correction" && (insertedPayslips || []).length > 0) {
      const insertedPayslipIds = (insertedPayslips || []).map((row: any) => row.id).filter(Boolean);
      if (insertedPayslipIds.length > 0) {
        const { error: finalizePayslipsErr } = await supabaseAdmin
          .from("payslips")
          .update({ status: "pending" })
          .in("id", insertedPayslipIds);
        if (finalizePayslipsErr) {
          await supabaseAdmin.from("payslips").delete().eq("payroll_run_id", payrollRun.id);
          await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
          throw finalizePayslipsErr;
        }
      }
    }
    if (allInputRows.length > 0) {
      const { error: inErr } = await supabaseAdmin.from("payslip_inputs").insert(allInputRows);
      if (inErr) {
        console.warn("[compute-payroll] payslip_inputs insert failed (non-fatal):", inErr.message);
      }
    }

    // ─── Phase 3 — Persist rule-graph provenance traces ───
    // Non-fatal: payslip_lines are the authoritative amounts. Traces
    // back the historical simulator + rule-graph debug UI.
    const traceRowsToInsert: any[] = [];
    for (const [empId, entry] of Object.entries(graphTracesByEmployee)) {
      const psId = psIdByEmployee.get(empId) ?? null;
      for (const t of entry.traces) {
        traceRowsToInsert.push({
          organization_id,
          business_id: business_id || null,
          payroll_run_id: payrollRun.id,
          payslip_id: psId,
          employee_id: empId,
          structure_id: entry.structure_id,
          rule_id: t.rule_id,
          rule_code: t.rule_code,
          sequence: t.sequence,
          category: t.category,
          condition_expression: t.condition_expression,
          condition_passed: t.condition_passed,
          amount_select: t.amount_select,
          amount_expression: t.amount_expression,
          amount_base: t.amount_base,
          base_value: t.base_value,
          dependencies: t.dependencies,
          resolved_amount: t.resolved_amount,
          error: t.error,
        });
      }
    }
    if (traceRowsToInsert.length > 0) {
      const { error: trErr } = await supabaseAdmin.from("payroll_rule_traces").insert(traceRowsToInsert);
      if (trErr) {
        console.warn("[compute-payroll] payroll_rule_traces insert failed (non-fatal):", trErr.message);
      }
    }


    // ─── Turn B2: consume approved loan skip overrides ───
    //
    // For every approved override that was actually honoured by the engine in
    // this run, mark the override row as `consumed` and call
    // `apply_loan_skip_schedule_adjustment` so the loan amortisation reacts per
    // the loan_type's `schedule_adjustment_on_skip` policy
    // (push_end / absorb_into_next / balloon / extend_tenure).
    if (runType !== "correction") {
      const consumedOverrides = [
        ...Object.values(overridesByScheduleId),
        ...Object.values(overridesByLoanIdForRun),
      ];
      const seen = new Set<string>();
      for (const ov of consumedOverrides) {
        if (seen.has(ov.id)) continue;
        seen.add(ov.id);
        try {
          await supabaseAdmin.rpc("apply_loan_skip_schedule_adjustment", {
            _override_id: ov.id,
            _payroll_run_id: payrollRun.id,
          } as any);
        } catch (e) {
          await supabaseAdmin.from("payroll_run_issues").insert({
            organization_id,
            business_id: business_id || null,
            payroll_run_id: payrollRun.id,
            employee_id: ov.employee_id,
            code: "LOAN_SKIP_ADJUSTMENT_FAILED",
            severity: "warning",
            message: `Skip applied but schedule adjustment failed: ${(e as Error).message}`,
            details: { override_id: ov.id, loan_id: ov.loan_id, schedule_id: ov.schedule_id },
          });
        }
      }
    }




    // ─── Turn C: stamp consumed expense reimbursements + bump garnishment totals ───
    //
    // Phase 3.4-followup #2 — these are additive bumps (garnishment.total_paid
    // monotonically increases, expenses.reimbursed_* is stamped once). On a
    // correction run they would double-count against the parent run's already-
    // applied bumps. Skip the stamping and emit a single info issue per
    // affected employee so an operator reconciles manually until proper
    // delta-aware adjusters ship.
    if (runType === "correction" && parentRunId) {
      // Phase 3.4-followup #6 — delta-aware adjusters gated behind
      // PAYROLL_CORRECTION_ADJUSTERS_V2. When the flag is OFF we keep the
      // legacy manual-reconcile fallback so existing tenants are byte-
      // identical until they opt in. When ON we compute signed deltas
      // against the parent run's payslip_lines, write them to the
      // payroll_correction_adjustments ledger (UPSERT on
      // (payroll_run_id, source_kind, source_id) — idempotent on
      // re-compute), and mutate legal_orders_records.total_paid by the
      // delta. Reimbursements are recorded in the ledger for audit but
      // never re-stamped on expenses (the parent run already did that).
      const v2 = (Deno.env.get("PAYROLL_CORRECTION_ADJUSTERS_V2") ?? "").toLowerCase() === "true";

      if (!v2) {
        const affected = new Set<string>();
        for (const r of reimbursementsConsumed) affected.add(r.employee_id);
        for (const g of garnishmentsApplied) {
          if ((g as any).employee_id) affected.add((g as any).employee_id);
        }
        if (affected.size > 0) {
          const rows = [...affected].map((empId) => ({
            organization_id,
            business_id: business_id || null,
            payroll_run_id: payrollRun.id,
            employee_id: empId,
            code: "CORRECTION_MANUAL_RECONCILE_REQUIRED",
            severity: "warning",
            message:
              "Correction run skipped garnishment total_paid / expense reimbursement stamping — reconcile manually against the parent run.",
            details: { parent_run_id: parentRunId },
          }));
          await supabaseAdmin.from("payroll_run_issues").insert(rows);
        }
      } else {
        try {
          // ─── Fetch parent payslip_lines for garnishment + reimbursement
          // sources. Legal orders are stored as category=post_tax_deduction
          // with source/input_ref kind=garnishment; reimbursements are stored
          // as category=earning with source/input_ref kind=reimbursement.
          const { data: parentLines, error: pErr } = await supabaseAdmin
            .from("payslip_lines")
            .select("employee_id, category, employee_amount, employer_amount, source, rule_code")
            .eq("payroll_run_id", parentRunId)
            .in("category", ["post_tax_deduction", "earning"]);
          if (pErr) throw pErr;

          // Aggregate parent amounts by (employee_id, source_kind, source_id).
          // source_id comes from source/input_ref garnishment_id or expense_id.
          type Key = string; // `${empId}|${kind}|${sourceId}`
          const k = (e: string, kind: string, sid: string): Key => `${e}|${kind}|${sid}`;
          const parentAmt = new Map<Key, number>();
          const allKeys = new Map<Key, { empId: string; kind: "garnishment" | "reimbursement"; sourceId: string }>();
          for (const ln of (parentLines || []) as any[]) {
            const src = (ln.source || {}) as Record<string, any>;
            const inputRef = (src.input_ref || {}) as Record<string, any>;
            const kind = (src.kind || inputRef.kind) as "garnishment" | "reimbursement" | undefined;
            if (kind !== "garnishment" && kind !== "reimbursement") continue;
            const sid = kind === "garnishment"
              ? ((src.garnishment_id || inputRef.garnishment_id) as string)
              : ((src.expense_id || inputRef.expense_id) as string);
            if (!sid) continue;
            const key = k(ln.employee_id, kind, sid);
            parentAmt.set(key, (parentAmt.get(key) || 0) + Number(ln.employee_amount || ln.employer_amount || 0));
            allKeys.set(key, { empId: ln.employee_id, kind, sourceId: sid });
          }

          // Aggregate new amounts from this correction run.
          const newAmt = new Map<Key, number>();
          for (const g of garnishmentsApplied) {
            const key = k(g.employee_id, "garnishment", g.id);
            newAmt.set(key, (newAmt.get(key) || 0) + Number(g.amount || 0));
            allKeys.set(key, { empId: g.employee_id, kind: "garnishment", sourceId: g.id });
          }
          // For reimbursements the per-line amount lives on the new payslip
          // lines we just inserted; recover it from `allLineRows` (still in
          // scope above) by source/input_ref expense_id.
          for (const ln of allLineRows as any[]) {
            const src = (ln.source || {}) as Record<string, any>;
            const inputRef = (src.input_ref || {}) as Record<string, any>;
            if ((src.kind || inputRef.kind) !== "reimbursement") continue;
            const sid = src.expense_id || inputRef.expense_id;
            if (!sid) continue;
            const key = k(ln.employee_id, "reimbursement", sid);
            newAmt.set(key, (newAmt.get(key) || 0) + Number(ln.employee_amount || ln.employer_amount || 0));
            allKeys.set(key, { empId: ln.employee_id, kind: "reimbursement", sourceId: sid });
          }

          const ledgerRows: any[] = [];
          const unsafeIssues: any[] = [];
          const garnDeltaByGid: Record<string, number> = {};

          for (const [key, meta] of allKeys) {
            const p = parentAmt.get(key) || 0;
            const n = newAmt.get(key) || 0;
            const delta = Math.round((n - p) * 100) / 100;
            if (delta === 0) continue;
            ledgerRows.push({
              organization_id,
              business_id: business_id || null,
              payroll_run_id: payrollRun.id,
              parent_run_id: parentRunId,
              employee_id: meta.empId,
              source_kind: meta.kind,
              source_id: meta.sourceId,
              signed_amount: delta,
              notes: `Correction Δ vs parent run ${parentRunId}`,
            });
            if (meta.kind === "garnishment") {
              garnDeltaByGid[meta.sourceId] = (garnDeltaByGid[meta.sourceId] || 0) + delta;
            }
          }

          if (ledgerRows.length > 0) {
            const { error: lErr } = await supabaseAdmin
              .from("payroll_correction_adjustments")
              .upsert(ledgerRows, { onConflict: "payroll_run_id,source_kind,source_id" });
            if (lErr) throw lErr;
          }

          // Apply garnishment deltas to total_accrued (accrual ledger), clamped to
          // [0, total_owed]. total_paid stays in sync only via real remittance.
          for (const [gid, delta] of Object.entries(garnDeltaByGid)) {
            const { data: cur, error: gErr } = await supabaseAdmin
              .from("legal_orders_records" as any)
              .select("total_accrued, total_owed, status, end_date")
              .eq("id", gid)
              .single();
            if (gErr || !cur) {
              unsafeIssues.push({
                organization_id,
                business_id: business_id || null,
                payroll_run_id: payrollRun.id,
                employee_id: null,
                code: "CORRECTION_RECONCILE_UNSAFE",
                severity: "warning",
                message: `Garnishment ${gid} could not be resolved while applying correction delta.`,
                details: { parent_run_id: parentRunId, source_kind: "garnishment", source_id: gid, delta },
              });
              continue;
            }
            const totalOwed = Number(cur.total_owed || 0);
            const curAccrued = Number(cur.total_accrued || 0);
            let newAccrued = Math.round((curAccrued + delta) * 100) / 100;
            if (newAccrued < 0) newAccrued = 0;
            if (totalOwed > 0 && newAccrued > totalOwed) {
              unsafeIssues.push({
                organization_id,
                business_id: business_id || null,
                payroll_run_id: payrollRun.id,
                employee_id: null,
                code: "CORRECTION_RECONCILE_UNSAFE",
                severity: "warning",
                message: `Garnishment ${gid} delta would exceed total_owed; clamped to total.`,
                details: { parent_run_id: parentRunId, source_id: gid, delta, total_owed: totalOwed, attempted: newAccrued },
              });
              newAccrued = totalOwed;
            }
            await supabaseAdmin
              .from("legal_orders_records" as any)
              .update({ total_accrued: newAccrued })
              .eq("id", gid);
          }

          if (unsafeIssues.length > 0) {
            await supabaseAdmin.from("payroll_run_issues").insert(unsafeIssues);
          }
        } catch (e: any) {
          console.error("[compute-payroll] correction adjusters V2 failed:", e?.message ?? e);
          // Fall back to a single audit issue so the operator is alerted.
          await supabaseAdmin.from("payroll_run_issues").insert([{
            organization_id,
            business_id: business_id || null,
            payroll_run_id: payrollRun.id,
            employee_id: null,
            code: "CORRECTION_RECONCILE_UNSAFE",
            severity: "warning",
            message: `Correction adjusters V2 failed: ${e?.message ?? String(e)}. Reconcile manually.`,
            details: { parent_run_id: parentRunId },
          }]);
        }
      }
    } else try {
      for (const r of reimbursementsConsumed) {
        const psId = psIdByEmployee.get(r.employee_id);
        if (!psId) continue;
        await supabaseAdmin
          .from("expenses")
          .update({
            reimbursed_payslip_id: psId,
            reimbursed_run_id: payrollRun.id,
            reimbursed_at: new Date().toISOString(),
          })
          .eq("id", r.id);
      }
      // Aggregate garnishment totals per garnishment id and bump total_accrued.
      // total_paid is bumped only when remittance allocations land (see
      // apply_garnishment_payment_to_order trigger).
      const garnTotals: Record<string, number> = {};
      for (const g of garnishmentsApplied) garnTotals[g.id] = (garnTotals[g.id] || 0) + g.amount;
      for (const [gid, amt] of Object.entries(garnTotals)) {
        const { data: cur } = await supabaseAdmin
          .from("legal_orders_records" as any)
          .select("total_accrued")
          .eq("id", gid)
          .single();
        const newAccrued = Math.round(((Number(cur?.total_accrued) || 0) + amt) * 100) / 100;
        await supabaseAdmin
          .from("legal_orders_records" as any)
          .update({ total_accrued: newAccrued })
          .eq("id", gid);
      }

      // P6: persist carry-forward bookkeeping for this run.
      if (cfConsumedIds.length > 0) {
        await supabaseAdmin
          .from("garnishment_carry_forward")
          .update({
            consumed_by_run_id: payrollRun.id,
            consumed_at: new Date().toISOString(),
          })
          .in("id", cfConsumedIds);
      }
      if (cfInserts.length > 0) {
        await supabaseAdmin
          .from("garnishment_carry_forward")
          .insert(cfInserts);
      }
    } catch (e: any) {
      console.warn("[compute-payroll] garnishment/reimbursement stamping failed:", e?.message ?? e);
    }

    // ─── Slice 2: custom deductions post-run bookkeeping ───
    // Bump cumulative_recovered; auto-complete when cap is reached; write
    // a lifecycle event stamped with the payroll_run_id so an operator
    // can audit which run consumed which amount.
    try {
      const cdTotals: Record<string, { amount: number; type_id: string; employee_id: string }> = {};
      for (const c of customDeductionsApplied) {
        const slot = cdTotals[c.assignment_id] ||= { amount: 0, type_id: c.type_id, employee_id: c.employee_id };
        slot.amount = Math.round((slot.amount + c.amount) * 100) / 100;
      }
      for (const [assignmentId, agg] of Object.entries(cdTotals)) {
        const { data: cur } = await supabaseAdmin
          .from("employee_custom_deductions")
          .select("cumulative_recovered, cumulative_cap, status")
          .eq("id", assignmentId)
          .single();
        if (!cur) continue;
        const newRecovered = Math.round(((Number(cur.cumulative_recovered) || 0) + agg.amount) * 100) / 100;
        const shouldComplete =
          cur.cumulative_cap != null && newRecovered >= Number(cur.cumulative_cap) - 0.005;
        const patch: Record<string, unknown> = { cumulative_recovered: newRecovered };
        if (shouldComplete) patch.status = "completed";
        await supabaseAdmin
          .from("employee_custom_deductions")
          .update(patch)
          .eq("id", assignmentId);
        await supabaseAdmin.from("employee_custom_deduction_events").insert({
          assignment_id: assignmentId,
          business_id: business_id || null,
          event_type: "recovered",
          amount: agg.amount,
          payroll_run_id: payrollRun.id,
        });
      }
    } catch (e: any) {
      console.warn("[compute-payroll] custom deduction bookkeeping failed:", e?.message ?? e);
    }



    // ─── Drain retro_pay_adjustments queue (B-2) ───
    // For every employee in this run with pending retro deltas whose
    // effective_from <= pay_period_end, materialize a delta payslip linked
    // via retro_of_payslip_id, copy delta_lines into payslip_lines, and
    // mark the queue row 'applied'. Failure is non-fatal (logged) because
    // primary payslips must not be rolled back by retro plumbing.
    try {
      const { data: pendingRetros, error: retroErr } = await supabaseAdmin
        .from("retro_pay_adjustments")
        .select("id, employee_id, source_payslip_id, effective_from, delta_lines, delta_gross, delta_employee_deductions, delta_net, reason")
        .eq("organization_id", organization_id)
        .eq("status", "pending")
        .in("employee_id", employee_ids)
        .lte("effective_from", pay_period_end);

      if (retroErr) {
        console.warn("[compute-payroll] retro fetch failed:", retroErr.message);
      } else if (pendingRetros && pendingRetros.length > 0) {
        const retroPayslipRows = pendingRetros.map((r: any) => ({
          payroll_run_id: payrollRun.id,
          employee_id: r.employee_id,
          organization_id,
          business_id: business_id || null,
          // Phase 4 P1.2c: retro payslip header carries only universal
          // totals + lineage. Per-line decomposition is materialised
          // below from r.delta_lines into payslip_lines.
          gross_pay: Number(r.delta_gross || 0),
          total_deductions: Number(r.delta_employee_deductions || 0),
          net_pay: Number(r.delta_net || 0),
          taxable_income: 0,
          status: "draft",
          retro_of_payslip_id: r.source_payslip_id,
          retro_effective_from: r.effective_from,
        }));

        const { data: retroInserted, error: rInsErr } = await supabaseAdmin
          .from("payslips")
          .insert(retroPayslipRows)
          .select("id, retro_of_payslip_id");

        if (rInsErr) {
          console.warn("[compute-payroll] retro payslip insert failed:", rInsErr.message);
        } else if (retroInserted) {
          const retroPsIdBySource = new Map<string, string>();
          for (const row of retroInserted) {
            if (row.retro_of_payslip_id) retroPsIdBySource.set(row.retro_of_payslip_id, row.id);
          }
          const retroLineRows: any[] = [];
          const appliedUpdates: { id: string; payslip_id: string }[] = [];
          for (const r of pendingRetros as any[]) {
            const psId = retroPsIdBySource.get(r.source_payslip_id);
            if (!psId) continue;
            appliedUpdates.push({ id: r.id, payslip_id: psId });
            const lines = Array.isArray(r.delta_lines) ? r.delta_lines : [];
            for (const ln of lines) {
              retroLineRows.push(normalizePayslipLineRow({
                ...ln,
                payslip_id: psId,
                payroll_run_id: payrollRun.id,
                employee_id: r.employee_id,
                organization_id,
                business_id: business_id || null,
              }));
            }
          }
          if (retroLineRows.length > 0) {
            const { error: rlErr } = await supabaseAdmin.from("payslip_lines").insert(retroLineRows);
            if (rlErr) console.warn("[compute-payroll] retro payslip_lines insert failed:", rlErr.message);
          }
          for (const upd of appliedUpdates) {
            await supabaseAdmin
              .from("retro_pay_adjustments")
              .update({
                status: "applied",
                applied_run_id: payrollRun.id,
                applied_payslip_id: upd.payslip_id,
                applied_at: new Date().toISOString(),
              })
              .eq("id", upd.id);
          }
          console.log(`[compute-payroll] retro: materialized ${retroInserted.length} delta payslip(s)`);
        }
      }
    } catch (e: any) {
      console.warn("[compute-payroll] retro drain unexpected error:", e?.message ?? e);
    }

    // ─── Record loan repayments ───
    if (loanDeductionsToRecord.length > 0) {
      // Enrich each item with payslip_id (now that payslips are inserted)
      const enriched = loanDeductionsToRecord.map((d) => ({
        ...d,
        payslip_id: psIdByEmployee.get(d.employee_id) ?? null,
      }));
      const { error: loanBatchError } = await supabaseAdmin.rpc("process_payroll_loan_deductions", {
        _payroll_run_id: payrollRun.id,
        _payroll_number: finalPayrollNumber,
        _deductions: enriched,
      });

      if (loanBatchError) {
        console.error("Loan repayment recording failed, rolling back payroll:", loanBatchError);
        await supabaseAdmin.from("payslip_lines").delete().eq("payroll_run_id", payrollRun.id);
        await supabaseAdmin.from("payslips").delete().eq("payroll_run_id", payrollRun.id);
        await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
        throw new Error(`Payroll rolled back: loan repayment failed — ${loanBatchError.message}`);
      }
    }

    // ─── Record advance recoveries ───
    // Single writer: `process_payroll_advance_recoveries` owns the schedule
    // rows and the advance balance/status transition, exactly as
    // `process_payroll_loan_deductions` does for loans. Composing those writes
    // here would be a second settlement implementation.
    if (advanceRecoveriesToRecord.length > 0) {
      const { error: advErr } = await supabaseAdmin.rpc("process_payroll_advance_recoveries", {
        _payroll_run_id: payrollRun.id,
        _payroll_number: finalPayrollNumber,
        _period_start: pay_period_start,
        _period_end: pay_period_end,
        _recoveries: advanceRecoveriesToRecord.map((r) => ({
          advance_id: r.advance_id,
          amount: r.amount,
          payslip_id: psIdByEmployee.get(r.employee_id) ?? null,
        })),
      });
      if (advErr) {
        console.error("Advance recovery recording failed, rolling back payroll:", advErr);
        await supabaseAdmin.from("payslip_lines").delete().eq("payroll_run_id", payrollRun.id);
        await supabaseAdmin.from("payslips").delete().eq("payroll_run_id", payrollRun.id);
        await supabaseAdmin.from("payroll_runs").delete().eq("id", payrollRun.id);
        throw new Error(`Payroll rolled back: advance recovery failed — ${advErr.message}`);
      }
    }


    // ─── Audit log ───
    await supabaseAdmin.from("audit_logs").insert({
      organization_id,
      business_id: business_id || null,
      user_id: userId,
      action: "created",
      entity_type: "payroll_run",
      entity_id: payrollRun.id,
      entity_name: finalPayrollNumber,
      new_values: {
        payroll_number: finalPayrollNumber,
        pay_period_start,
        pay_period_end,
        employee_count: payslipsData.length,
        total_gross: totalGross,
        total_net: totalNet,
        total_deductions: totalDeductions,
        total_employer_contributions: totalEmployerContributions,
        loan_deductions_count: loanDeductionsToRecord.length,
        contracts_used: Object.keys(contractByEmployee).length,
      },
      changes_summary: `Created payroll ${finalPayrollNumber} with ${payslipsData.length} employees, gross ${totalGross.toFixed(2)}, net ${totalNet.toFixed(2)}`,
    }).then(({ error: auditErr }) => {
      if (auditErr) console.error("Audit log error:", auditErr);
    });

    // ─── Project payroll_work_entries via the single authoritative writer ───
    // ADR-0042: payroll_work_entries_project is the ONLY writer to
    // payroll_work_entries. This edge function no longer inserts rows
    // directly — it delegates so attendance, leave, timesheets, holidays
    // and overtime all flow through one typed projector.
    try {
      const { error: projErr } = await supabaseAdmin.rpc(
        "payroll_work_entries_project",
        { _run_id: payrollRun.id },
      );
      if (projErr) {
        console.warn("[compute-payroll] payroll_work_entries_project failed:", projErr.message);
      }
    } catch (weExc) {
      console.warn("[compute-payroll] payroll_work_entries_project exception (non-fatal):", weExc);
    }


    // ─── Wave 4: mark consumed termination payouts ───
    if (consumedPayoutIds.length > 0) {
      const { error: ptpErr } = await supabaseAdmin
        .from("pending_termination_payouts")
        .update({ status: "consumed", consumed_run_id: payrollRun.id })
        .in("id", consumedPayoutIds);
      if (ptpErr) {
        console.warn("[compute-payroll] pending_termination_payouts mark consumed failed:", ptpErr.message);
      }
    }


    // ─── Lock attendance records ───
    try {
      const { error: lockErr } = await supabaseAdmin.rpc("attendance_lock_for_period", {
        _organization_id: organization_id,
        _from: pay_period_start,
        _to: pay_period_end,
        _payroll_run_id: payrollRun.id,
        _employee_ids: employee_ids,
      });
      if (lockErr) {
        console.warn("[compute-payroll] attendance_lock_for_period failed:", lockErr.message);
      }
    } catch (lockExc) {
      console.warn("[compute-payroll] attendance lock exception (non-fatal):", lockExc);
    }

    // ─── SMS notifications ───
    try {
      const outboxRows = payslipsData.map((ps: any) => ({
        organization_id,
        business_id: business_id || null,
        event_type: "payroll_processed",
        entity_type: "payslip",
        entity_id: null,
        recipient_phone: null,
        recipient_contact_id: ps.employee_id,
        template_variables: {
          employee_name: ps._employee_name || "",
          payroll_number: finalPayrollNumber,
          pay_period_start,
          pay_period_end,
          net_pay: Number(ps.net_pay || 0).toFixed(2),
          gross_pay: Number(ps.gross_pay || 0).toFixed(2),
        },
      }));
      if (outboxRows.length > 0) {
        const { error: outboxErr } = await supabaseAdmin
          .from("sms_event_outbox")
          .insert(outboxRows);
        if (outboxErr) {
          console.warn(`[compute-payroll] sms outbox insert skipped: ${outboxErr.message}`);
        }
      }
    } catch (smsErr) {
      console.warn("[compute-payroll] payroll_processed SMS enqueue failed:", smsErr);
    }

    // ─── Phase 4: compute-time GL mapping short-circuit ─────────────────
    // Historically the mapping gate only fired at post-payroll-gl time.
    // Enterprise payroll platforms surface mapping gaps at the moment the
    // run is computed so approvers never authorise a run that cannot be
    // posted. We call the same two RPCs the posting function uses and
    // write blocker/error rows into `payroll_run_issues`; existing UI
    // gates that check for open blocker issues will refuse to move the
    // run past draft until they are resolved.
    let mappingIssueCount = 0;
    try {
      const { data: reqRows } = await supabaseAdmin.rpc(
        "payroll_required_gl_mappings_for_run",
        { p_run_id: payrollRun.id },
      );
      const missing = ((reqRows || []) as any[]).filter((r) => !r.is_mapped);
      if (missing.length > 0) {
        const rows = missing.map((r: any) => ({
          organization_id,
          business_id: business_id || null,
          payroll_run_id: payrollRun.id,
          employee_id: null,
          code: "GL_MAPPING_MISSING",
          severity: "blocker",
          message: `Missing GL mapping for '${r.label ?? r.setting_key}'. Bind it in Payroll → GL Account Mapping before this run can be posted.`,
          details: {
            setting_key: r.setting_key,
            rule_code: r.rule_code ?? null,
            kind: r.kind,
            suggested_account_id: r.suggested_account_id ?? null,
          },
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await supabaseAdmin.from("payroll_run_issues").insert(rows.slice(i, i + 500));
        }
        mappingIssueCount += missing.length;
      }

      const { data: roleRows } = await supabaseAdmin.rpc(
        "payroll_validate_post_mappings",
        { p_run_id: payrollRun.id },
      );
      const violations = (roleRows || []) as any[];
      if (violations.length > 0) {
        const rows = violations.map((v: any) => ({
          organization_id,
          business_id: business_id || null,
          payroll_run_id: payrollRun.id,
          employee_id: null,
          code: "GL_MAPPING_ROLE_VIOLATION",
          severity: "blocker",
          message: v.violation ?? `GL mapping for '${v.setting_key}' violates accounting role rules.`,
          details: v,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await supabaseAdmin.from("payroll_run_issues").insert(rows.slice(i, i + 500));
        }
        mappingIssueCount += violations.length;
      }
    } catch (mapErr: any) {
      // Fail loud, not silent: if the mapping check itself errors we cannot
      // assert the run is postable, so we record a blocker issue. The run
      // stays gated until the check can pass (either the mappings are fixed
      // or the transient error clears on a recompute) rather than sliding
      // through to approval on an unverified GL routing.
      console.error("[compute-payroll] mapping short-circuit check failed:", mapErr);
      try {
        await supabaseAdmin.from("payroll_run_issues").insert({
          organization_id,
          business_id: business_id || null,
          payroll_run_id: payrollRun.id,
          employee_id: null,
          code: "GL_MAPPING_CHECK_FAILED",
          severity: "blocker",
          message:
            "GL mapping validation could not be completed for this run. Recompute after confirming Payroll → GL Account Mapping is configured; the run cannot be approved until the check passes.",
          details: { error: String(mapErr?.message ?? mapErr) },
        });
        mappingIssueCount += 1;
      } catch (issueErr) {
        console.error(
          "[compute-payroll] failed to record GL_MAPPING_CHECK_FAILED issue:",
          issueErr,
        );
      }
    }

    const successPayload = {
      payroll_run: payrollRun,
      employee_count: payslipsData.length,
      warnings,
      mapping_issue_count: mappingIssueCount,
    };
    await finalizeJob("succeeded", {
      result: successPayload,
      payrollRunId: (payrollRun as any)?.id ?? null,
    });
    console.log("[compute-payroll] job succeeded", {
      jobId, key: idempotencyKey,
      payrollRunId: (payrollRun as any)?.id ?? null,
      employees: payslipsData.length,
    });
    return new Response(JSON.stringify(successPayload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("[compute-payroll] job failed", {
      jobId, key: idempotencyKey,
      error: error?.message, code: error?.code,
    });
    if (jobId && supabaseAdminOuter) {
      try {
        await supabaseAdminOuter
          .from("payroll_run_jobs")
          .update({
            status: "failed",
            phase: "failed",
            finished_at: new Date().toISOString(),
            error_code: error?.code ?? null,
            error_message: error?.message ?? String(error),
          })
          .eq("id", jobId);
      } catch (e) {
        console.error("[compute-payroll] outer finalize failed:", (e as Error).message);
      }
    }
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
