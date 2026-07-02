/**
 * Stage D guard — sandboxed payroll expression engine.
 */
import { describe, it, expect } from "vitest";
import {
  parseExpression,
  evaluateExpression,
  validateExpression,
  RuleExpressionError,
  MAX_TOKENS,
  type PayrollContext,
} from "@/lib/payroll/expressionValidator";

const ctx: PayrollContext = {
  BASIC: 1000, GROSS: 1200, TAXABLE: 1100, NET: 900,
  employee: { country_code: "KE", age: 30, dependants: 2, marital_status: "single", gender: "f" },
  contract: { wage: 1000, hours_per_week: 40, structure_code: "STD" },
  worked_hours: { WORK: 160, OT: 8 },
  worked_days: { WORK: 20 },
  result: { BASIC: 1000, HRA: 200 },
};

describe("expression engine — happy paths", () => {
  it("arithmetic + precedence", () => {
    expect(evaluateExpression("1 + 2 * 3", ctx)).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3", ctx)).toBe(9);
  });
  it("scalar + member + index lookups", () => {
    expect(evaluateExpression("BASIC + result['HRA']", ctx)).toBe(1200);
    expect(evaluateExpression("employee.dependants * 100", ctx)).toBe(200);
    expect(evaluateExpression("worked_hours['OT'] * 1.5", ctx)).toBe(12);
  });
  it("ternary + comparison + logical", () => {
    expect(evaluateExpression("BASIC > 500 ? 100 : 0", ctx)).toBe(100);
    expect(evaluateExpression("employee.age >= 18 && BASIC > 0", ctx)).toBe(true);
  });
  it("helper functions", () => {
    expect(evaluateExpression("min(BASIC, 500)", ctx)).toBe(500);
    expect(evaluateExpression("max(BASIC, 500)", ctx)).toBe(1000);
    expect(evaluateExpression("round(123.456, 1)", ctx)).toBe(123.5);
    expect(evaluateExpression("if(BASIC > 0, 10, 20)", ctx)).toBe(10);
  });
});

describe("expression engine — guardrails", () => {
  it("rejects unknown identifier", () => {
    expect(() => evaluateExpression("SOMETHING + 1", ctx)).toThrow(RuleExpressionError);
  });
  it("rejects unknown employee field", () => {
    expect(() => evaluateExpression("employee.ssn", ctx)).toThrow(/unknown field employee.ssn/);
  });
  it("rejects unknown function", () => {
    expect(() => evaluateExpression("eval(1)", ctx)).toThrow(/unknown function/);
  });
  it("division by zero", () => {
    expect(() => evaluateExpression("1 / 0", ctx)).toThrow(/division by zero/);
  });
  it("token cap", () => {
    const big = Array.from({ length: MAX_TOKENS + 5 }, () => "1").join(" + ");
    expect(() => parseExpression(big)).toThrow(/exceeds/);
  });
  it("depth cap", () => {
    const deep = "(".repeat(40) + "1" + ")".repeat(40);
    expect(() => parseExpression(deep)).toThrow(/nesting exceeds/);
  });
  it("syntax error reports offset", () => {
    const r = validateExpression("1 + ");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(typeof r.offset).toBe("number");
  });
  it("forbids assignment / no = operator", () => {
    expect(() => parseExpression("a = 1")).toThrow();
  });
});
