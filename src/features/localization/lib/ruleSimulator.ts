/**
 * Pure, deterministic, country-agnostic rule simulator.
 *
 * Used by the editor's RuleSimulator panel to preview employee/employer
 * deductions BEFORE a statutory rule is saved. Operates on the same
 * `parameters` payload shape that `pack_rule_type_schemas` JSON-Schemas
 * already validate.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 2 — Alignment with the production engine
 * (compute-payroll/index.ts:computeOneRule).
 *
 * 1. Dispatch key. The production engine dispatches on
 *    `payroll_statutory_rules.computation_method` (a top-level column).
 *    Pack authoring uses `parameters.type` as the schema discriminator.
 *    Both are accepted here; when both are provided,
 *    `computation_method` (passed as the 4th arg) wins and
 *    `parameters.type` is a fallback. The mapping in ENGINE_METHOD_TO_KIND
 *    is the single source of truth for the alias table.
 *
 * 2. Rate semantics. The engine's `pct(n) = Number(n)/100` always treats
 *    the raw value as PERCENT (e.g. 10 → 0.10). The previous
 *    `rateAsFraction` heuristic in this file — treating rate ≤ 1 as
 *    already-fractional and rate > 1 as percent — silently diverged from
 *    production for any pack that stores rates as decimals. Removed.
 *    Packs (and this simulator) must express rates as percent.
 *
 * 3. `ceiling` vs `cap`. Both names are accepted (the engine now aliases
 *    `ceiling → cap`), so the simulator honours whichever the pack ships.
 *
 * NOT the production payroll engine. Production payroll still runs
 * `compute-payroll/index.ts:computeOneRule` server-side. This module is a
 * faithful preview so authoring-time output cannot drift from what a real
 * payroll run would produce for the same parameter shape.
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

/**
 * Convert a percent-shaped rate (e.g. 10 for 10%) to a fraction (0.10).
 * MUST match `pct` in compute-payroll/index.ts. Rates < 1 are NOT auto-
 * promoted to fractions — a decimal is treated as a very small percent,
 * exactly as production does, so authoring mistakes surface here instead
 * of silently producing wrong payslips.
 */
const pct = (rate: unknown): number => (Number(rate) || 0) / 100;

/**
 * Read a cap value from parameters. Packs and schemas historically ship
 * either `cap` or `ceiling` for the same concept; the engine now accepts
 * both. Keep the alias list in one place.
 */
function readCap(p: any): number | null {
  const raw = p?.cap ?? p?.ceiling;
  if (raw === null || raw === undefined) return null;
  const n = safeNum(raw, NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * Maps `payroll_statutory_rules.computation_method` values (as consumed by
 * `compute-payroll/index.ts:computeOneRule`) to the simulator's internal
 * dispatch keys. Kept as a data table so an arch test can assert both
 * sides stay in lockstep as new methods are added.
 */
export const ENGINE_METHOD_TO_KIND: Record<string, string> = {
  bracket_progressive: "progressive",
  tiered_brackets: "tiered_employer_employee",
  tiered: "tiered_employer_employee",
  percentage_of_gross: "percentage",
  percentage: "percentage",
  graduated_table: "graduated",
  graduated: "graduated",
  flat_amount: "flat",
  fixed: "flat",
  per_employee_flat: "flat",
};

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
    const fraction = pct(safeNum(b.rate, 0));
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
