/**
 * PayslipLineExplainer adaptor unit tests.
 *
 * The adaptor coerces the engine-authored `payslip_lines.source` jsonb
 * into the shared BreakdownTable view contract. We test the four
 * source shapes the popover supports plus the legacy null fallback so
 * that future engine changes can't silently break the explainer.
 */
import { describe, it, expect } from "vitest";
import { __test__ } from "@/components/payroll/PayslipLineExplainer";

const { adaptSourceToBreakdown } = __test__;

const baseLine = {
  id: "l1",
  rule_code: "PAYE",
  label: "PAYE",
  employee_amount: 8432,
  employer_amount: 0,
};

describe("adaptSourceToBreakdown", () => {
  it("flattens bracket_breakdown into employee rows", () => {
    const out = adaptSourceToBreakdown({
      ...baseLine,
      source: {
        bracket_breakdown: [
          { from: 0, to: 24000, rate: 0.1, base: 24000, amount: 2400 },
          { from: 24000, to: 32333, rate: 0.25, base: 8333, amount: 2083 },
          { from: 32333, to: null, rate: 0.3, base: 12996, amount: 3949 },
        ],
      },
    });
    expect(out.employeeRows).toHaveLength(3);
    expect(out.employerRows).toHaveLength(0);
    expect(out.employeeRows[2].label).toContain("∞");
    expect(out.employeeRows[1].rate).toBe(0.25);
  });

  it("synthesises a single row from a flat-rate source", () => {
    const out = adaptSourceToBreakdown({
      ...baseLine,
      employee_amount: 1500,
      source: { rate: 0.06, base: 25000 },
    });
    expect(out.employeeRows).toHaveLength(1);
    expect(out.employeeRows[0].amount).toBe(1500);
    expect(out.employeeRows[0].rate).toBe(0.06);
  });

  it("respects pre-split employee/employer arrays", () => {
    const out = adaptSourceToBreakdown({
      ...baseLine,
      source: {
        employee: [{ label: "NSSF tier 1", amount: 360 }],
        employer: [{ label: "NSSF tier 1 (er)", amount: 360 }],
      },
    });
    expect(out.employeeRows[0].label).toBe("NSSF tier 1");
    expect(out.employerRows[0].amount).toBe(360);
  });

  it("captures explanation prose alongside numeric rows", () => {
    const out = adaptSourceToBreakdown({
      ...baseLine,
      source: {
        bracket_breakdown: [{ from: 0, to: 1000, rate: 0.1, amount: 100 }],
        explanation: "Insurance relief of 15% applied.",
      },
    });
    expect(out.explanation).toEqual(["Insurance relief of 15% applied."]);
    expect(out.employeeRows).toHaveLength(1);
  });

  it("returns empty rows when source is null (legacy line)", () => {
    const out = adaptSourceToBreakdown({ ...baseLine, source: null });
    expect(out.employeeRows).toEqual([]);
    expect(out.employerRows).toEqual([]);
    expect(out.explanation).toEqual([]);
  });
});