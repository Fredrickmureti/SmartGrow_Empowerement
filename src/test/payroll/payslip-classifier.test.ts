/**
 * Contract test for the unified payslip-line classifier.
 *
 * The classifier is the single source of truth shared by:
 *   - `supabase/functions/_shared/payslip/payslipSnapshot.ts` (Deno)
 *   - `src/components/payroll/PayslipDetailDialog.tsx` (browser)
 *
 * Drift between those two surfaces was the original Critical Defect.
 * These tests pin the behaviour so any future change must update both
 * mirrors in lock-step.
 */
import { describe, it, expect } from "vitest";
import { classifyPayslipLine } from "@/lib/payroll/payslipClassifier";

describe("classifyPayslipLine", () => {
  it("buckets every known earning category", () => {
    for (const cat of ["earning", "basic", "allowance", "bonus", "overtime"]) {
      expect(classifyPayslipLine({ category: cat })).toBe("earning");
    }
  });

  it("buckets every known deduction category", () => {
    for (const cat of [
      "deduction", "statutory_employee", "tax", "income_tax",
      "loan_repayment", "benefit_recovery", "voluntary_deduction", "garnishment",
    ]) {
      expect(classifyPayslipLine({ category: cat })).toBe("deduction");
    }
  });

  it("buckets employer-side categories independently of amounts", () => {
    expect(classifyPayslipLine({ category: "statutory_employer", employee_amount: 0, employer_amount: 500 }))
      .toBe("employer_contribution");
    expect(classifyPayslipLine({ category: "training_levy", employer_amount: 100 }))
      .toBe("employer_contribution");
  });

  it("does NOT promote unknown categories to earning or deduction (no substring guessing)", () => {
    expect(classifyPayslipLine({ category: "weird_new_thing", employee_amount: 999 })).toBe("info");
    expect(classifyPayslipLine({ category: null })).toBe("info");
    expect(classifyPayslipLine({})).toBe("info");
  });

  it("keeps a negative earning (clawback) classified as an earning", () => {
    // The legacy substring heuristic flipped this to deduction.
    expect(classifyPayslipLine({ category: "earning", employee_amount: -250 })).toBe("earning");
  });

  it("is case-insensitive on category", () => {
    expect(classifyPayslipLine({ category: "BASIC" })).toBe("earning");
    expect(classifyPayslipLine({ category: "Statutory_Employee" })).toBe("deduction");
  });
});
