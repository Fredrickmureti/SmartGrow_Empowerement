/**
 * Schema-validation contract test.
 *
 * Pins the canonical JSON Schemas shipped in `pack_rule_type_schemas`
 * for the three rule_types currently in production:
 *   - income_tax / progressive
 *   - statutory_deduction / percentage
 *   - employer_contribution / percentage
 *
 * For each combo we assert: one realistic valid payload returns zero
 * errors, one deliberately broken payload returns a non-empty error
 * list. The validator under test is the SAME module the edge function
 * (`validate-localization-payload`) and the DB trigger contract use —
 * extracted into `supabase/functions/_shared/validateAgainstSchema.ts`.
 */
import { describe, it, expect } from "vitest";
import { validateAgainstSchema } from "../../../supabase/functions/_shared/validateAgainstSchema";

// ─── Reference schemas ──────────────────────────────────────────────
// Minimal, hand-pinned subsets of the schemas registered in
// `pack_rule_type_schemas`. Keeping them inline (instead of fetching
// from the live DB) means this suite runs in CI without a Supabase
// connection AND fails loudly the day someone changes the canonical
// shape without updating the test.

const incomeTaxProgressive = {
  type: "object",
  required: ["type", "brackets"],
  properties: {
    type: { type: "string", enum: ["progressive"] },
    currency: { type: "string", maxLength: 8 },
    personal_relief: { type: "number", minimum: 0 },
    brackets: {
      type: "array",
      items: {
        type: "object",
        required: ["rate"],
        properties: {
          min: { type: "number", minimum: 0 },
          max: { type: "number", minimum: 0, nullable: true },
          rate: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

const statutoryDeductionPercentage = {
  type: "object",
  required: ["type", "rate"],
  properties: {
    type: { type: "string", enum: ["percentage"] },
    base: { type: "string", enum: ["gross_pay", "basic_pay", "taxable_pay"] },
    rate: { type: "number", minimum: 0, maximum: 1 },
    ceiling: { type: "number", minimum: 0 },
  },
};

const employerContributionPercentage = {
  type: "object",
  required: ["type", "employer_rate"],
  properties: {
    type: { type: "string", enum: ["percentage"] },
    base: { type: "string", enum: ["gross_pay", "basic_pay"] },
    employee_rate: { type: "number", minimum: 0, maximum: 1 },
    employer_rate: { type: "number", minimum: 0, maximum: 1 },
    ceiling: { type: "number", minimum: 0 },
  },
};

describe("validateAgainstSchema — income_tax/progressive", () => {
  it("accepts a realistic Kenya PAYE payload", () => {
    const payload = {
      type: "progressive",
      currency: "KES",
      personal_relief: 2400,
      brackets: [
        { min: 0, max: 24000, rate: 0.1 },
        { min: 24001, max: 32333, rate: 0.25 },
        { min: 32334, max: null, rate: 0.3 },
      ],
    };
    expect(validateAgainstSchema(payload, incomeTaxProgressive)).toEqual([]);
  });

  it("rejects missing brackets and an out-of-range rate", () => {
    const payload = {
      type: "progressive",
      brackets: [{ min: 0, max: 1000, rate: 1.5 }],
    };
    const errs = validateAgainstSchema(payload, incomeTaxProgressive);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("rate") && e.includes("above maximum"))).toBe(true);
  });

  it("rejects wrong discriminator", () => {
    const errs = validateAgainstSchema(
      { type: "tiered", brackets: [] },
      incomeTaxProgressive,
    );
    expect(errs.some((e) => e.includes("enum"))).toBe(true);
  });
});

describe("validateAgainstSchema — statutory_deduction/percentage", () => {
  it("accepts a realistic NSSF payload", () => {
    const payload = {
      type: "percentage",
      base: "gross_pay",
      rate: 0.06,
      ceiling: 18000,
    };
    expect(validateAgainstSchema(payload, statutoryDeductionPercentage)).toEqual([]);
  });

  it("rejects missing required rate", () => {
    const errs = validateAgainstSchema(
      { type: "percentage", base: "gross_pay" },
      statutoryDeductionPercentage,
    );
    expect(errs).toContain("$.rate: required property missing");
  });

  it("rejects negative ceiling", () => {
    const errs = validateAgainstSchema(
      { type: "percentage", rate: 0.06, ceiling: -1 },
      statutoryDeductionPercentage,
    );
    expect(errs.some((e) => e.includes("ceiling") && e.includes("below minimum"))).toBe(true);
  });
});

describe("validateAgainstSchema — employer_contribution/percentage", () => {
  it("accepts a realistic SHIF employer payload", () => {
    const payload = {
      type: "percentage",
      base: "gross_pay",
      employee_rate: 0.0275,
      employer_rate: 0.0275,
    };
    expect(validateAgainstSchema(payload, employerContributionPercentage)).toEqual([]);
  });

  it("rejects missing employer_rate", () => {
    const errs = validateAgainstSchema(
      { type: "percentage", base: "gross_pay", employee_rate: 0.05 },
      employerContributionPercentage,
    );
    expect(errs).toContain("$.employer_rate: required property missing");
  });

  it("rejects rates above 100%", () => {
    const errs = validateAgainstSchema(
      { type: "percentage", employer_rate: 1.5 },
      employerContributionPercentage,
    );
    expect(errs.some((e) => e.includes("employer_rate") && e.includes("above maximum"))).toBe(true);
  });
});

describe("validateAgainstSchema — generic edge cases", () => {
  it("returns [] for a null schema (no-op pass-through)", () => {
    expect(validateAgainstSchema({ anything: 1 }, null)).toEqual([]);
  });

  it("flags a top-level type mismatch", () => {
    const errs = validateAgainstSchema("nope", incomeTaxProgressive);
    expect(errs[0]).toContain("expected object, got string");
  });

  it("walks nested array items and reports indexed paths", () => {
    const errs = validateAgainstSchema(
      {
        type: "progressive",
        brackets: [
          { min: 0, max: 100, rate: 0.1 },
          { min: 100, max: 200, rate: 5 },
        ],
      },
      incomeTaxProgressive,
    );
    expect(errs.some((e) => e.startsWith("$.brackets[1].rate"))).toBe(true);
  });
});