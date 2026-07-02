/**
 * Pure, deterministic, country-agnostic rule simulator.
 *
 * Used by the editor's RuleSimulator panel to preview employee/employer
 * deductions BEFORE a statutory rule is saved. Operates on the same
 * `parameters` payload shape that `pack_rule_type_schemas` JSON-Schemas
 * already validate, so authoring-time UI and runtime payroll cannot drift
 * on shape (only the evaluator semantics need to track production).
 *
 * NOT the production payroll engine. Production payroll uses
 * `compute-payroll/structureEngine.ts`, which references statutory rules
 * via `statutory_ref` salary-rule rows. This module mirrors the math
 * applied to the same parameter shapes so the simulator gives a faithful
 * preview without round-tripping to the edge function.
 */

export interface SimulatorInputs {
  /** Gross salary for the simulated period. */
  gross: number;
  /** "monthly" | "annual" — used only for breakdown labels. */
  period: "monthly" | "annual";
  /** Optional housing allowance, used by some PAYE rules' housing exemption. */
  housing?: number;
  /** Optional pension contribution (subtracted from taxable for some PAYE rules). */
  pension?: number;
  /** Optional pre-resolved taxable amount. If provided, overrides the above. */
  taxable?: number;
}

export interface BreakdownRow {
  label: string;
  base: number;
  rate?: number; // displayed as percent in UI
  amount: number;
  side: "employee" | "employer";
}

export interface SimulationResult {
  employee_amount: number;
  employer_amount: number;
  breakdown: BreakdownRow[];
  explanation: string[];
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const safeNum = (v: any, fallback = 0) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
};

/** Detect whether a `rate` field is expressed in percent (0..100) or fraction (0..1). */
function rateAsFraction(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  // Heuristic: anything > 1 is treated as a percent value (10 → 0.10).
  return rate > 1 ? rate / 100 : rate;
}

function pickBracketKeys(brackets: any[]): { lowerKey: string; upperKey: string } {
  const sample = brackets[0] ?? {};
  return {
    lowerKey: "min" in sample ? "min" : "lower",
    upperKey: "max" in sample ? "max" : "upper",
  };
}

function pickTierKeys(tiers: any[]): { lowerKey: string; upperKey: string } {
  const sample = tiers[0] ?? {};
  return {
    lowerKey: "lower_earnings_limit" in sample ? "lower_earnings_limit" : "lower",
    upperKey: "upper_earnings_limit" in sample ? "upper_earnings_limit" : "upper",
  };
}

/**
 * Apply a progressive bracket schedule (PAYE-style).
 * Each bracket taxes the slice of `taxable` that falls inside [lower, upper).
 */
function applyProgressive(
  brackets: any[],
  taxable: number,
  result: SimulationResult,
  labelPrefix = "Band",
): number {
  if (!Array.isArray(brackets) || brackets.length === 0) return 0;
  const sorted = [...brackets].sort((a, b) => safeNum(a.lower ?? a.min) - safeNum(b.lower ?? b.min));
  const { lowerKey, upperKey } = pickBracketKeys(sorted);
  let tax = 0;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const lo = safeNum(b[lowerKey], 0);
    const upRaw = b[upperKey];
    const up = upRaw === null || upRaw === undefined ? Infinity : safeNum(upRaw, Infinity);
    if (taxable <= lo) break;
    const slice = Math.max(0, Math.min(taxable, up) - lo);
    if (slice <= 0) continue;
    const fraction = rateAsFraction(safeNum(b.rate, 0));
    const amount = slice * fraction;
    tax += amount;
    result.breakdown.push({
      label: `${labelPrefix} ${i + 1}: ${lo.toLocaleString()} – ${up === Infinity ? "∞" : up.toLocaleString()}`,
      base: round2(slice),
      rate: fraction * 100,
      amount: round2(amount),
      side: "employee",
    });
  }
  return tax;
}

/**
 * Main simulator entry. Country-agnostic: dispatches off `parameters.type`
 * (the `computation_kind` discriminator from the JSON-Schema registry).
 */
export function simulateRule(
  rule_type: string,
  parameters: any,
  inputs: SimulatorInputs,
): SimulationResult {
  const result: SimulationResult = {
    employee_amount: 0,
    employer_amount: 0,
    breakdown: [],
    explanation: [],
    warnings: [],
  };

  if (!parameters || typeof parameters !== "object") {
    result.warnings.push("No parameters provided — cannot simulate.");
    return result;
  }

  const kind = parameters.type;
  const gross = safeNum(inputs.gross, 0);
  const housing = safeNum(inputs.housing, 0);
  const pension = safeNum(inputs.pension, 0);

  // Common taxable derivation: gross − pension, capped by an optional
  // housing exemption when the rule supplies one.
  const taxable = inputs.taxable !== undefined
    ? safeNum(inputs.taxable, 0)
    : Math.max(0, gross - pension);

  // ── Income tax / progressive or graduated ──────────────────────────────
  if (kind === "progressive" || kind === "graduated") {
    const brackets = parameters.brackets ?? parameters.bands ?? [];
    if (!Array.isArray(brackets) || brackets.length === 0) {
      result.warnings.push("No brackets configured.");
      return result;
    }
    const tax = applyProgressive(brackets, taxable, result, "Band");
    let net = tax;
    const personalRelief = safeNum(parameters.personal_relief, 0);
    if (personalRelief > 0) {
      net = Math.max(0, tax - personalRelief);
      result.breakdown.push({
        label: `Personal relief`,
        base: round2(tax),
        amount: round2(-Math.min(tax, personalRelief)),
        side: "employee",
      });
      result.explanation.push(
        `Tax before relief: ${round2(tax).toLocaleString()}. Personal relief of ${personalRelief.toLocaleString()} applied → final ${round2(net).toLocaleString()}.`,
      );
    } else {
      result.explanation.push(
        `Taxable amount ${round2(taxable).toLocaleString()} taxed across ${brackets.length} band(s) → ${round2(tax).toLocaleString()}.`,
      );
    }
    result.employee_amount = round2(net);
    return result;
  }

  // ── Statutory deduction / percentage ───────────────────────────────────
  if (kind === "percentage") {
    const fraction = rateAsFraction(safeNum(parameters.rate, 0));
    const baseLabel: string = parameters.base ?? "gross";
    const baseAmount = baseLabel === "taxable" ? taxable : gross;
    let amount = baseAmount * fraction;
    const cap = parameters.cap;
    if (cap !== null && cap !== undefined) {
      const capN = safeNum(cap, Infinity);
      if (amount > capN) {
        result.explanation.push(`Computed ${round2(amount).toLocaleString()} exceeds cap ${capN.toLocaleString()} — capped.`);
        amount = capN;
      }
    }
    result.breakdown.push({
      label: `${parameters.label ?? "Deduction"} (${(fraction * 100).toFixed(2)}% of ${baseLabel})`,
      base: round2(baseAmount),
      rate: fraction * 100,
      amount: round2(amount),
      side: "employee",
    });
    result.explanation.push(
      `${(fraction * 100).toFixed(2)}% of ${baseLabel} ${round2(baseAmount).toLocaleString()} = ${round2(amount).toLocaleString()}.`,
    );
    result.employee_amount = round2(amount);
    return result;
  }

  // ── Statutory deduction / flat ─────────────────────────────────────────
  if (kind === "flat") {
    const amount = safeNum(parameters.amount, 0);
    const cap = parameters.cap;
    const final = cap == null ? amount : Math.min(amount, safeNum(cap, Infinity));
    result.breakdown.push({
      label: `${parameters.label ?? "Flat deduction"}`,
      base: 0,
      amount: round2(final),
      side: "employee",
    });
    result.explanation.push(`Flat amount ${round2(final).toLocaleString()} applied per period.`);
    result.employee_amount = round2(final);
    return result;
  }

  // ── Pension (employee + employer mirror) ───────────────────────────────
  if (kind === "pension") {
    const fraction = rateAsFraction(safeNum(parameters.rate, 0));
    const baseAmount = gross;
    let amount = baseAmount * fraction;
    const cap = parameters.cap;
    if (cap !== null && cap !== undefined) {
      amount = Math.min(amount, safeNum(cap, Infinity));
    }
    result.breakdown.push({
      label: `Pension employee (${(fraction * 100).toFixed(2)}%)`,
      base: round2(baseAmount),
      rate: fraction * 100,
      amount: round2(amount),
      side: "employee",
    });
    result.breakdown.push({
      label: `Pension employer (${(fraction * 100).toFixed(2)}%)`,
      base: round2(baseAmount),
      rate: fraction * 100,
      amount: round2(amount),
      side: "employer",
    });
    result.employee_amount = round2(amount);
    result.employer_amount = round2(amount);
    result.explanation.push(`Pension contribution: ${(fraction * 100).toFixed(2)}% of ${round2(baseAmount).toLocaleString()} on each side.`);
    return result;
  }

  // ── Tiered employer/employee (NSSF-style) ──────────────────────────────
  if (kind === "tiered_employer_employee" || kind === "tiered") {
    const tiers = parameters.tiers ?? [];
    if (!Array.isArray(tiers) || tiers.length === 0) {
      result.warnings.push("No tiers configured.");
      return result;
    }
    const sorted = [...tiers].sort((a, b) => safeNum(a.lower ?? a.lower_earnings_limit) - safeNum(b.lower ?? b.lower_earnings_limit));
    const { lowerKey, upperKey } = pickTierKeys(sorted);
    let employeeTotal = 0;
    let employerTotal = 0;
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const lo = safeNum(t[lowerKey], 0);
      const upRaw = t[upperKey];
      const up = upRaw === null || upRaw === undefined ? Infinity : safeNum(upRaw, Infinity);
      if (gross <= lo) break;
      const slice = Math.max(0, Math.min(gross, up) - lo);
      if (slice <= 0) continue;
      const eFrac = rateAsFraction(safeNum(t.employee_rate, 0));
      const rFrac = rateAsFraction(safeNum(t.employer_rate, 0));
      const eAmt = slice * eFrac;
      const rAmt = slice * rFrac;
      employeeTotal += eAmt;
      employerTotal += rAmt;
      const name = t.name ?? `Tier ${i + 1}`;
      result.breakdown.push({
        label: `${name}: employee (${(eFrac * 100).toFixed(2)}% of ${round2(slice).toLocaleString()})`,
        base: round2(slice),
        rate: eFrac * 100,
        amount: round2(eAmt),
        side: "employee",
      });
      result.breakdown.push({
        label: `${name}: employer (${(rFrac * 100).toFixed(2)}% of ${round2(slice).toLocaleString()})`,
        base: round2(slice),
        rate: rFrac * 100,
        amount: round2(rAmt),
        side: "employer",
      });
    }
    result.employee_amount = round2(employeeTotal);
    result.employer_amount = round2(employerTotal);
    result.explanation.push(
      `Tiered contribution on gross ${round2(gross).toLocaleString()} → employee ${result.employee_amount.toLocaleString()}, employer ${result.employer_amount.toLocaleString()}.`,
    );
    return result;
  }

  // ── Employer contribution / fixed ──────────────────────────────────────
  if (kind === "fixed") {
    const amount = safeNum(parameters.amount, 0);
    result.breakdown.push({ label: `Employer fixed`, base: 0, amount: round2(amount), side: "employer" });
    result.employer_amount = round2(amount);
    result.explanation.push(`Employer pays a fixed ${round2(amount).toLocaleString()} per period.`);
    return result;
  }

  result.warnings.push(`Computation kind "${kind}" is not yet supported by the simulator.`);
  return result;
}
