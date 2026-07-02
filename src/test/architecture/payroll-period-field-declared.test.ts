/**
 * Architecture invariant: every payroll computation method must declare
 * scalar fields for every schema-required key the published rule schema
 * expects. Today the universal requirement is `period`. If a new schema
 * lands that requires another field (e.g. `accrual_basis`), this test
 * fails until ComputationMethodSpec is taught about it — preventing a
 * recurrence of the "$.period required" silent-strip bug.
 */
import { describe, it, expect } from "vitest";
import { COMPUTATION_METHODS, type ComputationMethod } from "@/lib/payroll/computationMethods";

const UNIVERSAL_REQUIRED_SCALARS = ["period", "currency"] as const;

describe("Payroll computation methods declare schema-required scalars", () => {
  for (const method of Object.keys(COMPUTATION_METHODS) as ComputationMethod[]) {
    const spec = COMPUTATION_METHODS[method];
    for (const required of UNIVERSAL_REQUIRED_SCALARS) {
      it(`${method} declares "${required}" as a scalar field`, () => {
        const keys = spec.scalarFields.map((f) => f.key);
        expect(keys).toContain(required);
      });
    }
  }

  it("period field is a select with at least monthly/annual/weekly options", () => {
    const spec = COMPUTATION_METHODS.tiered_brackets;
    const period = spec.scalarFields.find((f) => f.key === "period")!;
    expect(period.type).toBe("select");
    const values = (period.options ?? []).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["monthly", "annual", "weekly"]));
  });
});
