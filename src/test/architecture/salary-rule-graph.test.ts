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
  topoSortRules,
  type SalaryRule,
  type WorkEntryType,
  type WorkEntryRow,
  type StructureRuleTrace,
} from "../../../supabase/functions/compute-payroll/structureEngine";
import { extractIdentifiers } from "../../../supabase/functions/compute-payroll/expressionEngine";

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

// ─── Phase 3 — cycle detection, topo sort, provenance trace ───────────────

describe("extractIdentifiers", () => {
  it("returns rule-code dependencies from a sibling reference", () => {
    expect(extractIdentifiers("BASIC * 0.5 + HRA").sort()).toEqual(["BASIC", "HRA"]);
  });
  it("surfaces `result.<code>` and `result['code']` accesses", () => {
    expect(extractIdentifiers("result.BONUS + result['ALLOW'] * 2").sort()).toEqual(["ALLOW", "BONUS"]);
  });
  it("keeps context roots but not function names", () => {
    const ids = extractIdentifiers("round(min(BASIC, 1000) + employee.dependants * 100)").sort();
    expect(ids).toContain("BASIC");
    expect(ids).toContain("employee");
    expect(ids).not.toContain("round");
    expect(ids).not.toContain("min");
  });
});

describe("topoSortRules", () => {
  it("orders dependents after their dependencies regardless of sequence", () => {
    // Author BASIC after HRA-that-depends-on-BASIC on purpose — the topo
    // sort must still put BASIC first so HRA's percentage base resolves.
    const rules = [
      rule({ id: "2", code: "HRA", sequence: 10, category: "allowance", amount_select: "percentage", amount_percentage: 20, amount_base: "BASIC" }),
      rule({ id: "1", code: "BASIC", sequence: 20, amount_fixed: 1000 }),
    ];
    const r = topoSortRules(rules);
    expect("cycle" in r).toBe(false);
    if ("ordered" in r) {
      expect(r.ordered.map((x) => x.code)).toEqual(["BASIC", "HRA"]);
    }
  });

  it("reports a cycle instead of silently returning a bad order", () => {
    // A references B in its amount expression; B references A. Payroll
    // must refuse to run rather than evaluate both to 0.
    const rules = [
      rule({ id: "1", code: "A", sequence: 10, amount_select: "expression", amount_expression: "result.B + 1" }),
      rule({ id: "2", code: "B", sequence: 20, amount_select: "expression", amount_expression: "result.A + 1" }),
    ];
    const r = topoSortRules(rules);
    expect("cycle" in r).toBe(true);
    if ("cycle" in r) {
      expect(new Set(r.cycle)).toEqual(new Set(["A", "B"]));
    }
  });

  it("treats parent_rule_id as a dependency edge", () => {
    const rules = [
      rule({ id: "child", code: "CHILD", sequence: 5, parent_rule_id: "parent", amount_fixed: 10 }),
      rule({ id: "parent", code: "PARENT", sequence: 100, amount_fixed: 20 }),
    ];
    const r = topoSortRules(rules);
    if ("ordered" in r) {
      expect(r.ordered.map((x) => x.code)).toEqual(["PARENT", "CHILD"]);
    } else {
      throw new Error("unexpected cycle");
    }
  });
});

describe("runStructureEngine — cycles + trace", () => {
  it("short-circuits with a blocking error when the graph has a cycle", () => {
    const rules = [
      rule({ id: "1", code: "A", sequence: 10, amount_select: "expression", amount_expression: "result.B" }),
      rule({ id: "2", code: "B", sequence: 20, amount_select: "expression", amount_expression: "result.A" }),
    ];
    const r = runStructureEngine({ rules, workEntryTypes: types, workEntries: [], employee, contract });
    expect(r.lines).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].message).toMatch(/cycle/i);
  });

  it("populates traceSink with per-rule provenance including deps and base_value", () => {
    const rules = [
      rule({ id: "1", code: "BASIC", sequence: 10, amount_fixed: 1000 }),
      rule({ id: "2", code: "HRA", category: "allowance", sequence: 20, amount_select: "percentage", amount_percentage: 20, amount_base: "BASIC" }),
      rule({ id: "3", code: "SKIP", category: "allowance", sequence: 30, condition_select: "expression", condition_expression: "0", amount_fixed: 999 }),
    ];
    const traceSink: StructureRuleTrace[] = [];
    runStructureEngine({ rules, workEntryTypes: types, workEntries: [], employee, contract, traceSink });
    const byCode = Object.fromEntries(traceSink.map((t) => [t.rule_code, t]));
    expect(byCode.BASIC.resolved_amount).toBe(1000);
    expect(byCode.HRA.base_value).toBe(1000);
    expect(byCode.HRA.resolved_amount).toBe(200);
    expect(byCode.HRA.dependencies).toContain("BASIC");
    expect(byCode.SKIP.condition_passed).toBe(false);
    expect(byCode.SKIP.resolved_amount).toBe(0);
  });
});

