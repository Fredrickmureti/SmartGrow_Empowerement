/**
 * Stage D — structure engine guard tests.
 *
 * Imports the same module compute-payroll uses; runs against synthetic
 * fixtures so we can prove condition / amount / category aggregation logic
 * without touching the DB.
 */
import { describe, it, expect } from "vitest";
import {
  runStructureEngine,
  aggregateWorkedHours,
  type SalaryRule,
  type WorkEntryType,
  type WorkEntryRow,
} from "../../../supabase/functions/compute-payroll/structureEngine";

const types: WorkEntryType[] = [
  { id: "w1", code: "WORK", is_paid: true, counts_as_worked: true, multiplier_normal: 1, multiplier_overtime: 1.5 },
  { id: "w2", code: "OT", is_paid: true, counts_as_worked: true, multiplier_normal: 1, multiplier_overtime: 1.5 },
  { id: "w3", code: "UNPAID", is_paid: false, counts_as_worked: false, multiplier_normal: 0, multiplier_overtime: 0 },
];

const employee = { country_code: "KE", age: 30, dependants: 1, marital_status: "single", gender: "f" };
const contract = { wage: 1000, hours_per_week: 40, structure_code: "STD" };

function rule(over: Partial<SalaryRule>): SalaryRule {
  return {
    id: over.code ?? "r",
    code: "BASIC",
    name: "Basic",
    sequence: 10,
    category: "basic",
    parent_rule_id: null,
    condition_select: "always",
    condition_expression: null,
    amount_select: "fixed",
    amount_fixed: 0,
    amount_percentage: null,
    amount_base: null,
    amount_expression: null,
    statutory_rule_id: null,
    appears_on_payslip: true,
    accounting_debit_account_id: null,
    accounting_credit_account_id: null,
    accounting_tag: null,
    is_active: true,
    ...over,
  };
}

describe("aggregateWorkedHours", () => {
  it("applies multipliers and zeros unpaid leave", () => {
    const entries: WorkEntryRow[] = [
      { work_entry_type_id: "w1", hours: 160, overtime_hours: 0 },
      { work_entry_type_id: "w2", hours: 0, overtime_hours: 8 },
      { work_entry_type_id: "w3", hours: 16, overtime_hours: 0 },
    ];
    const { worked_hours } = aggregateWorkedHours(entries, types);
    expect(worked_hours.WORK).toBe(160);
    expect(worked_hours.OT).toBe(12); // 8 * 1.5
    expect(worked_hours.UNPAID).toBeUndefined();
  });
});

describe("runStructureEngine", () => {
  it("walks rules in sequence and aggregates by category", () => {
    const rules = [
      rule({ id: "1", code: "BASIC", sequence: 10, amount_select: "fixed", amount_fixed: 1000 }),
      rule({ id: "2", code: "HRA", category: "allowance", sequence: 20, amount_select: "percentage", amount_percentage: 20, amount_base: "BASIC" }),
      rule({ id: "3", code: "PAYE", category: "deduction", sequence: 30, amount_select: "expression", amount_expression: "GROSS * 0.1" }),
    ];
    const r = runStructureEngine({ rules, workEntryTypes: types, workEntries: [], employee, contract });
    expect(r.totals.basic).toBe(1000);
    expect(r.totals.gross).toBe(1200);
    expect(r.totals.deductions).toBe(120);
    expect(r.totals.net).toBe(1080);
    expect(r.errors).toEqual([]);
  });

  it("condition false skips amount entirely", () => {
    const rules = [
      rule({ id: "1", code: "BASIC", sequence: 10, amount_fixed: 1000 }),
      rule({
        id: "2", code: "BONUS", category: "allowance", sequence: 20,
        condition_select: "expression", condition_expression: "employee.dependants > 5",
        amount_select: "fixed", amount_fixed: 500,
      }),
    ];
    const r = runStructureEngine({ rules, workEntryTypes: types, workEntries: [], employee, contract });
    expect(r.totals.gross).toBe(1000);
    expect(r.lines.find((l) => l.code === "BONUS")).toBeUndefined();
  });

  it("appears_on_payslip=false still posts GL but is flagged hidden", () => {
    const rules = [
      rule({ id: "1", code: "BASIC", sequence: 10, amount_fixed: 1000 }),
      rule({ id: "2", code: "INTERNAL", category: "deduction", sequence: 20, amount_select: "fixed", amount_fixed: 50, appears_on_payslip: false, accounting_debit_account_id: "acct-1" }),
    ];
    const r = runStructureEngine({ rules, workEntryTypes: types, workEntries: [], employee, contract });
    const line = r.lines.find((l) => l.code === "INTERNAL");
    expect(line?.appears_on_payslip).toBe(false);
    expect(line?.accounting_debit_account_id).toBe("acct-1");
    expect(r.totals.deductions).toBe(50);
  });

  it("captures expression errors per rule without aborting the run", () => {
    const rules = [
      rule({ id: "1", code: "BASIC", sequence: 10, amount_fixed: 1000 }),
      rule({ id: "2", code: "BAD", sequence: 20, amount_select: "expression", amount_expression: "1 / 0" }),
      rule({ id: "3", code: "OK", category: "allowance", sequence: 30, amount_fixed: 100 }),
    ];
    const r = runStructureEngine({ rules, workEntryTypes: types, workEntries: [], employee, contract });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].rule_code).toBe("BAD");
    // Subsequent rules still ran
    expect(r.lines.find((l) => l.code === "OK")).toBeDefined();
  });

  it("statutory_ref delegates to the resolver", () => {
    const rules = [
      rule({ id: "1", code: "BASIC", sequence: 10, amount_fixed: 1000 }),
      rule({ id: "2", code: "PAYE", category: "deduction", sequence: 20, amount_select: "statutory_ref", statutory_rule_id: "stat-1" }),
    ];
    const r = runStructureEngine({
      rules,
      workEntryTypes: types,
      workEntries: [],
      employee,
      contract,
      statutoryResolver: (id) => (id === "stat-1" ? 137.5 : 0),
    });
    expect(r.totals.deductions).toBe(137.5);
  });
});
