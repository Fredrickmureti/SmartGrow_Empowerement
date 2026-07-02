/**
 * returnSourceResolver — single source of truth for resolving
 * `localization_pack_return_templates.body.columns[].source` tokens at
 * render time. Used by:
 *   - generate-statutory-return/index.ts          (CSV + PDF projection)
 *   - _shared/govFileWriter.ts                    (gov_csv submission file)
 *   - _shared/xmlWriter.ts                        (gov_xml submission file)
 *
 * All three call sites used to inline their own readSource(), and only
 * recognised three numeric sources. That made any pack rule referencing
 * per-rule sums or pre-tax-deduction taxable bases silently resolve to "".
 *
 * Country-agnostic: no rule code, identifier name, or currency is
 * hard-coded here — every per-rule breakdown is discovered from the
 * template body itself.
 */

export interface RuleSum {
  employee: number;
  employer: number;
}

export interface SourceContext {
  /**
   * Projected employee record. System columns (first_name, last_name,
   * employee_number, national_id, branch_id) plus every
   * (identifier_type, identifier_value) pair from
   * employee_statutory_identifiers.
   */
  employee: Record<string, unknown>;
  sums: {
    employee: number;            // sum of payslip_lines.employee_amount across filters.rule_codes
    employer: number;            // sum of payslip_lines.employer_amount across filters.rule_codes
    taxable: number;             // sum of payslips.taxable_income (fallback gross_pay)
    basic: number;               // sum of payslips.basic_salary
    allowances: number;          // sum of payslips.other_earnings
    byRule: Record<string, RuleSum>; // sum per rule_code referenced by the template
  };
}

/** Patterns the resolver understands beyond the static system sources. */
const EMPLOYEE_DYNAMIC = /^employee\.[a-z_][a-z0-9_]*$/;
const SUM_RULE = /^sum_rule\.([a-z0-9_]+)\.(employee|employer)$/;
const SUM_TAXABLE_MINUS_RULES = /^sum_taxable_minus_rules:([a-z0-9_,]+)$/;

/** Static sources every runtime knows directly. */
export const STATIC_SYSTEM_SOURCES = [
  "employee.full_name",
  "employee.first_name",
  "employee.last_name",
  "employee.employee_number",
  "employee.national_id",
  "employee.branch_id",
  "sum_employee_amount",
  "sum_employer_amount",
  "sum_taxable_amount",
  "sum_basic_pay",
  "sum_allowances",
  "row_count",
  "constant",
] as const;

/** Numeric sources (for total-row validation). */
export const NUMERIC_SOURCE_PREDICATES: Array<(s: string) => boolean> = [
  (s) => s === "sum_employee_amount" || s === "sum_employer_amount" || s === "sum_taxable_amount",
  (s) => s === "sum_basic_pay" || s === "sum_allowances",
  (s) => SUM_RULE.test(s),
  (s) => SUM_TAXABLE_MINUS_RULES.test(s),
];

export function isNumericSource(source: string): boolean {
  return NUMERIC_SOURCE_PREDICATES.some((p) => p(source));
}

/** True iff the resolver can read this source. */
export function isKnownSource(source: string): boolean {
  if (!source) return false;
  if ((STATIC_SYSTEM_SOURCES as readonly string[]).includes(source)) return true;
  if (source.startsWith("constant.")) return true;
  if (EMPLOYEE_DYNAMIC.test(source)) return true;
  if (SUM_RULE.test(source)) return true;
  if (SUM_TAXABLE_MINUS_RULES.test(source)) return true;
  return false;
}

/**
 * Walk every source string in the template and collect every rule code
 * the template needs beyond `filters.rule_codes`. The caller must add
 * these to the `payslip_lines` query so per-rule sums populate.
 */
export function extractExtraRuleCodes(sources: Iterable<string>): string[] {
  const codes = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    const m1 = SUM_RULE.exec(s);
    if (m1) {
      codes.add(m1[1]);
      continue;
    }
    const m2 = SUM_TAXABLE_MINUS_RULES.exec(s);
    if (m2) {
      for (const code of m2[1].split(",")) {
        const t = code.trim();
        if (t) codes.add(t);
      }
    }
  }
  return Array.from(codes);
}

function ruleSum(ctx: SourceContext, code: string): RuleSum {
  return ctx.sums.byRule[code] ?? { employee: 0, employer: 0 };
}

function round2(n: number): number {
  return Number((n || 0).toFixed(2));
}

/**
 * Resolve a source token to its runtime value. Unknown sources return
 * "" so a misconfigured pack produces a visible blank cell rather than
 * crashing the run.
 */
export function readSource(source: string, ctx: SourceContext): unknown {
  if (!source) return "";

  if (source === "row_count") return undefined; // handled by writer-level aggregation

  if (source.startsWith("constant.")) {
    return source.slice("constant.".length);
  }

  if (source.startsWith("employee.")) {
    const key = source.slice("employee.".length);
    if (key === "full_name") {
      const f = (ctx.employee as any).first_name ?? "";
      const l = (ctx.employee as any).last_name ?? "";
      return `${f} ${l}`.trim();
    }
    return (ctx.employee as any)[key] ?? "";
  }

  switch (source) {
    case "sum_employee_amount": return round2(ctx.sums.employee);
    case "sum_employer_amount": return round2(ctx.sums.employer);
    case "sum_taxable_amount":  return round2(ctx.sums.taxable);
    case "sum_basic_pay":       return round2(ctx.sums.basic);
    case "sum_allowances":      return round2(ctx.sums.allowances);
  }

  const m1 = SUM_RULE.exec(source);
  if (m1) {
    const r = ruleSum(ctx, m1[1]);
    return round2(m1[2] === "employer" ? r.employer : r.employee);
  }

  const m2 = SUM_TAXABLE_MINUS_RULES.exec(source);
  if (m2) {
    let v = ctx.sums.taxable;
    for (const code of m2[1].split(",")) {
      const t = code.trim();
      if (!t) continue;
      v -= ruleSum(ctx, t).employee;
    }
    return round2(v);
  }

  return "";
}