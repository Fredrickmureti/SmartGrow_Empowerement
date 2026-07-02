/**
 * payslipClassifier — single source of truth for bucketing a payslip line
 * into the four sections every mature payroll document recognises:
 *
 *   earning              — gross-up component (basic, allowance, overtime, bonus)
 *   deduction            — taken from the employee's gross
 *                          (statutory employee contribution, income tax,
 *                          loan repayment, benefit recovery, voluntary)
 *   employer_contribution — employer-side cost-of-employment
 *                          (statutory employer, training levies, pension match)
 *   info                 — informational only; never affects totals
 *
 * Driven EXCLUSIVELY by the authoritative `payslip_lines.category` enum
 * written by the compute-payroll engine. Substring heuristics are a
 * code smell — if a category isn't recognised the classifier returns
 * 'info' so it can never silently flip an unknown earning into a
 * deduction (the bug this module was extracted to fix).
 *
 * Pure TS / zero dependencies — consumed by both Deno (PDF generator)
 * and the browser (PayslipDetailDialog) via a parallel re-export at
 * `src/lib/payroll/payslipClassifier.ts`.
 */

export type PayslipLineBucket = "earning" | "deduction" | "employer_contribution" | "info";

export interface ClassifiableLine {
  category?: string | null;
  employee_amount?: number | null;
  employer_amount?: number | null;
}

const EARNING = new Set(["earning", "basic", "allowance", "bonus", "overtime"]);
const DEDUCTION = new Set([
  "deduction",
  "statutory_employee",
  "tax",
  "income_tax",
  "loan_repayment",
  "benefit_recovery",
  "voluntary_deduction",
  "garnishment",
]);
const EMPLOYER = new Set([
  "employer_contribution",
  "statutory_employer",
  "training_levy",
  "pension_employer",
]);

/**
 * Classify a payslip line. Returns 'info' for anything the engine didn't
 * categorise — keeps the renderer honest instead of guessing from amounts.
 */
export function classifyPayslipLine(line: ClassifiableLine): PayslipLineBucket {
  const cat = String(line.category ?? "").toLowerCase();
  if (EARNING.has(cat)) return "earning";
  if (DEDUCTION.has(cat)) return "deduction";
  if (EMPLOYER.has(cat)) return "employer_contribution";
  return "info";
}

/**
 * True iff this line carries an employee-side amount that should
 * appear in the employee's portion of the payslip / portal view.
 */
export function isEmployeeFacing(line: ClassifiableLine): boolean {
  const bucket = classifyPayslipLine(line);
  return bucket === "earning" || bucket === "deduction";
}
