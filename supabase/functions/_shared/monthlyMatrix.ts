// @ts-nocheck — Deno runtime
/**
 * monthlyMatrix — pivots the country-agnostic monthly rule-code stream
 * (`payroll_employee_monthly_breakdown` output) into a semantic 12-row
 * matrix keyed by rule_code, and applies pack-authored derived columns.
 *
 * This is the ADR-0060 addendum contract: country packs describe the
 * columns they want (e.g. statutory certificate columns A–O), and the platform pivots the
 * data. Templates never need to know rule codes explicitly — they bind
 * layout columns to matrix keys. Derived columns are declared alongside
 * the table block via a tiny expression DSL evaluated here, keeping
 * legal/regulatory math inside the localization pack.
 *
 * DSL (per derived column):
 *   { key: "chargeable_pay", expr: "sub", args: ["gross_pay", "total_relief_deductions"] }
 *   { key: "pension_30pct_of_basic", expr: "pct", args: ["basic_salary", 0.30] }
 *   { key: "pension_statutory_cap", expr: "min", args: ["pension_30pct_of_basic", "pension_contribution_actual", 30000] }
 *   { key: "total_relief_deductions", expr: "sum", args: ["pension_statutory_cap","ahl_employee","shif_employee","prmf_employee","mortgage_interest_relief_base"] }
 *   { key: "net_tax", expr: "sub", args: ["gross_tax", "personal_relief", "insurance_relief"] }
 *
 * Args are either matrix column keys (looked up per-row) or numeric
 * literals. Unknown keys resolve to 0. Order of `derived[]` matters —
 * later expressions may reference earlier derived keys.
 */

export interface MonthlyRuleCodeRow {
  month_index: number;
  rule_code: string;
  category?: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
}

export type DerivedExpr = "sum" | "sub" | "min" | "max" | "pct";

export interface DerivedColumn {
  key: string;
  expr: DerivedExpr;
  args: Array<string | number>;
  amount_field?: "employee_amount" | "employer_amount" | "taxable_amount";
}

export interface MonthlyMatrixRow {
  month_index: number;
  [key: string]: number | string;
}

/** Map a rule_code stream + explicit rule_codes to a 12-row matrix.
 *
 * In addition to per-rule-code columns, every monthly row also exposes
 * category-aggregate columns keyed `cat:<category>` (e.g. `cat:earning`,
 * `cat:statutory_employee`). These synthetic keys are the country-neutral
 * escape hatch used by generic certificate templates (e.g.
 * ANNUAL_EARNINGS_STATEMENT) that cannot hardcode country-specific rule
 * codes but still need to sum "all earnings", "all deductions", etc.
 * `derived_columns` args reference them the same way as rule codes.
 */
export function pivotToMonthlyMatrix(
  rows: MonthlyRuleCodeRow[],
  ruleCodes: string[],
  amountField: "employee_amount" | "employer_amount" | "taxable_amount" = "employee_amount",
): MonthlyMatrixRow[] {
  const byMonth = new Map<number, MonthlyMatrixRow>();
  // Categories we always seed to 0 so downstream derived_columns that
  // reference a category with no matching payslip_lines row still resolve
  // to a numeric 0 instead of undefined (which argValue would also treat
  // as 0, but seeding keeps the row shape predictable for tests + PDF).
  const SEED_CATEGORIES = [
    "earning",
    "deduction",
    "statutory_employee",
    "statutory_employer",
    "relief",
    "benefit",
  ];
  for (let m = 1; m <= 12; m++) {
    // Keep both keys intentionally:
    // - `month_index` is the ADR-0060 canonical resolver field.
    // - `month` is the template-facing field used by existing P9 matrix
    //   bodies whose first column is `{ key: "month", format: "month_short" }`.
    // Without this alias the monthly rows exist, but the visible Month cell
    // renders blank because the compiler looks up `row.month`.
    const seed: MonthlyMatrixRow = { month_index: m, month: m };
    for (const rc of ruleCodes) seed[rc] = 0;
    for (const cat of SEED_CATEGORIES) seed[`cat:${cat}`] = 0;
    byMonth.set(m, seed);
  }
  for (const r of rows) {
    const m = Number(r.month_index);
    if (!Number.isFinite(m) || m < 1 || m > 12) continue;
    const row = byMonth.get(m)!;
    const key = r.rule_code;
    if (!(key in row)) row[key] = 0;
    const amt = Number((r as any)[amountField]) || 0;
    row[key] = (Number(row[key]) || 0) + amt;
    // Category rollup — every row contributes to its `cat:<category>` key,
    // regardless of whether its rule_code was requested in `ruleCodes`.
    const cat = (r as any).category ? String((r as any).category) : "";
    if (cat) {
      const catKey = `cat:${cat}`;
      row[catKey] = (Number(row[catKey]) || 0) + amt;
    }
  }
  return Array.from(byMonth.values());
}


function argValue(row: MonthlyMatrixRow, a: string | number): number {
  if (typeof a === "number") return a;
  const v = row[a];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

export function applyDerivedColumns(
  rows: MonthlyMatrixRow[],
  derived: DerivedColumn[] | undefined,
): MonthlyMatrixRow[] {
  if (!derived || derived.length === 0) return rows;
  for (const row of rows) {
    for (const d of derived) {
      const args = (d.args ?? []).map((a) => argValue(row, a));
      let v = 0;
      switch (d.expr) {
        case "sum": v = args.reduce((a, b) => a + b, 0); break;
        case "sub":
          v = args.length ? args[0] - args.slice(1).reduce((a, b) => a + b, 0) : 0;
          break;
        case "min": v = args.length ? Math.min(...args) : 0; break;
        case "max": v = args.length ? Math.max(...args) : 0; break;
        case "pct": v = (args[0] ?? 0) * (args[1] ?? 0); break;
        default: v = 0;
      }
      row[d.key] = v;
    }
  }
  return rows;
}

export function projectMonthlyMatrix(
  rows: MonthlyRuleCodeRow[],
  ruleCodes: string[],
  derived?: DerivedColumn[],
  amountField: "employee_amount" | "employer_amount" | "taxable_amount" = "employee_amount",
): MonthlyMatrixRow[] {
  return applyDerivedColumns(pivotToMonthlyMatrix(rows, ruleCodes, amountField), derived);
}
