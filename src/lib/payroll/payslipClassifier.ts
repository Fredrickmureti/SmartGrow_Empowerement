/**
 * Browser-side mirror of `supabase/functions/_shared/payslipClassifier.ts`.
 *
 * The two files MUST stay in lock-step — any change to one requires the
 * matching change to the other. They are kept as physical mirrors rather
 * than a symlink because Vite (browser) and Deno (edge) resolve module
 * paths differently and we don't want a bundler trick to be the thing
 * keeping the payslip semantics consistent.
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
  "pre_tax_deduction",
  "post_tax_deduction",
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

export function classifyPayslipLine(line: ClassifiableLine): PayslipLineBucket {
  const cat = String(line.category ?? "").toLowerCase();
  if (EARNING.has(cat)) return "earning";
  if (DEDUCTION.has(cat)) return "deduction";
  if (EMPLOYER.has(cat)) return "employer_contribution";
  return "info";
}

export function isEmployeeFacing(line: ClassifiableLine): boolean {
  const bucket = classifyPayslipLine(line);
  return bucket === "earning" || bucket === "deduction";
}
