/**
 * Single source of truth for payroll statutory-rule computation methods.
 *
 * The compute-payroll edge function dispatches strictly on
 * `rule.computation_method`. The Statutory Rule editor MUST use the same
 * contract so the UI cannot create a rule the engine will silently skip.
 *
 * If you add a new method here, you MUST also implement it in
 * supabase/functions/compute-payroll/index.ts and vice-versa.
 */

export type ComputationMethod =
  | "bracket_progressive"
  | "tiered_brackets"
  | "percentage_of_gross"
  | "graduated_table"
  | "flat_amount"
  | "per_employee_flat";

export type ScalarFieldType = "number" | "text" | "percentage" | "select";

export interface ScalarField {
  key: string;
  label: string;
  type: ScalarFieldType;
  optional?: boolean;
  hint?: string;
  placeholder?: string;
  /** For type="select" only */
  options?: { value: string; label: string }[];
  /** Default value applied when creating a new rule */
  default?: string | number | boolean;
}

export interface ArrayFieldColumn {
  key: string;
  label: string;
  type: "number" | "text" | "percentage";
  optional?: boolean;
  /** Allow empty/null to represent "open ended" (e.g. last bracket max) */
  allowOpenEnded?: boolean;
  hint?: string;
}

export interface ArrayField {
  key: "brackets" | "tiers";
  label: string;
  description: string;
  columns: ArrayFieldColumn[];
  /** Minimum row count for a valid rule */
  minRows?: number;
  /** When true, the last row's `max`/`upper_earnings_limit` must be empty (open ended) */
  forceOpenEndedTop?: boolean;
}

export interface ComputationMethodSpec {
  method: ComputationMethod;
  label: string;
  description: string;
  scalarFields: ScalarField[];
  arrayField?: ArrayField;
  /** Returns array of human errors. Empty = valid. */
  validate: (parameters: Record<string, any>) => string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function validateBracketsContiguous(
  rows: any[],
  maxKey: "max" | "upper_earnings_limit",
  minKey: "min" | "lower_earnings_limit",
  forceOpenEndedTop: boolean,
): string[] {
  const errs: string[] = [];
  if (rows.length === 0) {
    errs.push("At least one bracket/tier is required.");
    return errs;
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lo = num(row[minKey]);
    const hi = num(row[maxKey]);
    if (lo === null) {
      errs.push(`Row ${i + 1}: lower bound is required.`);
    }
    const isLast = i === rows.length - 1;
    if (!isLast && hi === null) {
      errs.push(`Row ${i + 1}: upper bound is required (only the last row may be open-ended).`);
    }
    if (lo !== null && hi !== null && hi <= lo) {
      errs.push(`Row ${i + 1}: upper bound must be greater than lower bound.`);
    }
    if (i > 0) {
      const prev = rows[i - 1];
      const prevHi = num(prev[maxKey]);
      if (prevHi !== null && lo !== null && lo !== prevHi + 1 && lo !== prevHi) {
        errs.push(`Row ${i + 1}: lower bound (${lo}) does not continue from previous upper (${prevHi}).`);
      }
    }
  }
  if (forceOpenEndedTop) {
    const top = rows[rows.length - 1];
    if (num(top[maxKey]) !== null) {
      errs.push(`The top row must have an empty upper bound (open-ended).`);
    }
  }
  return errs;
}

const BASE_OPTIONS = [
  { value: "gross_pay", label: "Gross pay" },
  { value: "taxable_pay", label: "Taxable pay" },
  { value: "basic_pay", label: "Basic pay" },
  { value: "pensionable_pay", label: "Pensionable pay" },
];

/**
 * Universal scalar fields required by every published `pack_rule_type_schemas`
 * row (see migration 20260515105547). Declared once and prepended to every
 * computation-method spec so the editor never strips them via
 * `normalizeParameters`. Adding a new universal required field — keep it here.
 */
const PERIOD_FIELD: ScalarField = {
  key: "period",
  label: "Period",
  type: "select",
  default: "monthly",
  options: [
    { value: "monthly", label: "Monthly" },
    { value: "annual", label: "Annual" },
    { value: "weekly", label: "Weekly" },
  ],
  hint: "Required by the published rule schema. Most statutory rules are monthly.",
};

const CURRENCY_FIELD: ScalarField = {
  key: "currency",
  label: "Currency",
  type: "text",
  placeholder: "e.g. KES, NGN, ZAR",
  hint: "ISO 4217 3-letter currency code. Required — must match the org/business operating currency.",
};

export const COMPUTATION_METHODS: Record<ComputationMethod, ComputationMethodSpec> = {
  bracket_progressive: {
    method: "bracket_progressive",
    label: "Progressive brackets (income tax)",
    description:
      "Marginal rates applied to each slice of taxable pay. Used for PAYE / income tax. Supports personal relief and insurance relief.",
    scalarFields: [
      PERIOD_FIELD,
      CURRENCY_FIELD,
      { key: "personal_relief", label: "Personal relief (per period)", type: "number", optional: true },
      { key: "insurance_relief_rate", label: "Insurance relief rate (%)", type: "percentage", optional: true, hint: "Applied to insurance premiums declared on the payslip." },
      { key: "insurance_relief_max", label: "Insurance relief cap", type: "number", optional: true },
      { key: "disability_exemption", label: "Disability exemption", type: "number", optional: true },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
    arrayField: {
      key: "brackets",
      label: "Tax brackets",
      description: "Each bracket applies its rate to income within (min, max]. The top bracket must be open-ended.",
      columns: [
        { key: "min", label: "From", type: "number" },
        { key: "max", label: "To", type: "number", allowOpenEnded: true, hint: "Leave blank on the top bracket" },
        { key: "rate", label: "Rate (%)", type: "percentage" },
      ],
      minRows: 1,
      forceOpenEndedTop: true,
    },
    validate: (p) => {
      const errs: string[] = [];
      const brackets = Array.isArray(p.brackets) ? p.brackets : [];
      errs.push(...validateBracketsContiguous(brackets, "max", "min", true));
      for (let i = 0; i < brackets.length; i++) {
        const r = num(brackets[i].rate);
        if (r === null || r < 0 || r > 100) errs.push(`Bracket ${i + 1}: rate must be 0–100%.`);
      }
      return errs;
    },
  },

  tiered_brackets: {
    method: "tiered_brackets",
    label: "Contribution tiers (employee + employer)",
    description:
      "Per-tier flat percentage contributions for both employee and employer (e.g. NSSF). Each tier has its own earnings band and rate.",
    scalarFields: [
      PERIOD_FIELD,
      CURRENCY_FIELD,
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
    arrayField: {
      key: "tiers",
      label: "Contribution tiers",
      description: "Each tier defines an earnings band and the employee + employer rates that apply to pay within that band.",
      columns: [
        { key: "name", label: "Tier name", type: "text" },
        { key: "lower_earnings_limit", label: "From", type: "number" },
        { key: "upper_earnings_limit", label: "To", type: "number", allowOpenEnded: true, hint: "Leave blank on the top tier" },
        { key: "employee_rate", label: "Employee %", type: "percentage" },
        { key: "employer_rate", label: "Employer %", type: "percentage" },
      ],
      minRows: 1,
      forceOpenEndedTop: false,
    },
    validate: (p) => {
      const errs: string[] = [];
      const tiers = Array.isArray(p.tiers) ? p.tiers : [];
      errs.push(...validateBracketsContiguous(tiers, "upper_earnings_limit", "lower_earnings_limit", false));
      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        if (!t.name || String(t.name).trim() === "") errs.push(`Tier ${i + 1}: name is required.`);
        const er = num(t.employee_rate);
        const pr = num(t.employer_rate);
        if (er === null || er < 0 || er > 100) errs.push(`Tier ${i + 1}: employee rate must be 0–100%.`);
        if (pr === null || pr < 0 || pr > 100) errs.push(`Tier ${i + 1}: employer rate must be 0–100%.`);
      }
      return errs;
    },
  },

  percentage_of_gross: {
    method: "percentage_of_gross",
    label: "Percentage of pay",
    description:
      "Single percentage applied to a base. Supports a separate employee/employer split or a single combined rate (e.g. SHIF, AHL).",
    scalarFields: [
      PERIOD_FIELD,
      CURRENCY_FIELD,
      { key: "base", label: "Base", type: "select", options: BASE_OPTIONS, default: "gross_pay" },
      { key: "rate", label: "Single rate (%)", type: "percentage", optional: true, hint: "Use this OR employee/employer split below." },
      { key: "employee_rate", label: "Employee rate (%)", type: "percentage", optional: true },
      { key: "employer_rate", label: "Employer rate (%)", type: "percentage", optional: true },
      { key: "ceiling", label: "Cap on base", type: "number", optional: true, hint: "Maximum amount of base used in the calculation." },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
    validate: (p) => {
      const errs: string[] = [];
      const single = num(p.rate);
      const er = num(p.employee_rate);
      const pr = num(p.employer_rate);
      const hasSplit = er !== null || pr !== null;
      if (single === null && !hasSplit) {
        errs.push("Provide either a single rate or at least one of employee/employer rate.");
      }
      if (single !== null && hasSplit) {
        errs.push("Use either a single rate or the employee/employer split — not both.");
      }
      for (const [k, v] of [["rate", single], ["employee_rate", er], ["employer_rate", pr]] as const) {
        if (v !== null && (v < 0 || v > 100)) errs.push(`${k} must be 0–100%.`);
      }
      if (!p.base) errs.push("Base is required.");
      return errs;
    },
  },

  graduated_table: {
    method: "graduated_table",
    label: "Graduated lookup table",
    description:
      "Flat amount per earnings band — used by legacy NHIF-style schemes. The amount is taken directly from the matched row.",
    scalarFields: [
      PERIOD_FIELD,
      CURRENCY_FIELD,
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
    arrayField: {
      key: "brackets",
      label: "Lookup table",
      description: "Each row maps an earnings band to a fixed amount. The top row must be open-ended.",
      columns: [
        { key: "min", label: "From", type: "number" },
        { key: "max", label: "To", type: "number", allowOpenEnded: true, hint: "Leave blank on the top row" },
        { key: "amount", label: "Amount", type: "number" },
      ],
      minRows: 1,
      forceOpenEndedTop: true,
    },
    validate: (p) => {
      const errs: string[] = [];
      const rows = Array.isArray(p.brackets) ? p.brackets : [];
      errs.push(...validateBracketsContiguous(rows, "max", "min", true));
      for (let i = 0; i < rows.length; i++) {
        const a = num(rows[i].amount);
        if (a === null || a < 0) errs.push(`Row ${i + 1}: amount must be ≥ 0.`);
      }
      return errs;
    },
  },

  flat_amount: {
    method: "flat_amount",
    label: "Flat amount",
    description: "Fixed amount per period regardless of earnings.",
    scalarFields: [
      PERIOD_FIELD,
      CURRENCY_FIELD,
      { key: "amount", label: "Amount", type: "number" },
      { key: "employee_only", label: "Employee only", type: "select", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }], optional: true, default: "false" },
      { key: "employer_only", label: "Employer only", type: "select", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }], optional: true, default: "false" },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
    validate: (p) => {
      const errs: string[] = [];
      const a = num(p.amount);
      if (a === null || a < 0) errs.push("Amount must be ≥ 0.");
      if (p.employee_only === true && p.employer_only === true) {
        errs.push("A rule cannot be both employee-only and employer-only.");
      }
      return errs;
    },
  },

  per_employee_flat: {
    method: "per_employee_flat",
    label: "Per-employee flat (employer levy)",
    description: "Employer-only flat amount charged per active employee per period (e.g. NITA).",
    scalarFields: [
      PERIOD_FIELD,
      CURRENCY_FIELD,
      { key: "amount_per_employee", label: "Amount per employee", type: "number" },
      { key: "notes", label: "Notes", type: "text", optional: true },
    ],
    validate: (p) => {
      const errs: string[] = [];
      const a = num(p.amount_per_employee);
      if (a === null || a < 0) errs.push("Amount per employee must be ≥ 0.");
      return errs;
    },
  },
};

export const COMPUTATION_METHOD_LIST: ComputationMethodSpec[] = Object.values(COMPUTATION_METHODS);

/**
 * Best-effort detection of computation method from a parameters payload.
 * Used only to seed the editor when opening a legacy rule whose
 * computation_method column is empty/`auto`. Never used by the engine.
 */
export function inferComputationMethod(params: Record<string, any> | null | undefined): ComputationMethod | null {
  if (!params || typeof params !== "object") return null;
  if (Array.isArray(params.tiers) && params.tiers.length > 0) return "tiered_brackets";
  if (Array.isArray(params.brackets) && params.brackets.length > 0) {
    const first = params.brackets[0] || {};
    if ("rate" in first) return "bracket_progressive";
    if ("amount" in first) return "graduated_table";
  }
  if (params.amount_per_employee != null) return "per_employee_flat";
  if (params.amount != null && params.rate == null) return "flat_amount";
  if (params.rate != null || params.employee_rate != null || params.employer_rate != null) return "percentage_of_gross";
  return null;
}

/**
 * Strip empty/null fields and coerce strings → numbers/booleans for the
 * scalar fields declared by a method's spec. Returns the cleaned parameters
 * payload that should be persisted to `payroll_statutory_rules.parameters`.
 */
export function normalizeParameters(method: ComputationMethod, raw: Record<string, any>): Record<string, any> {
  const spec = COMPUTATION_METHODS[method];
  const out: Record<string, any> = {};
  for (const f of spec.scalarFields) {
    const v = raw[f.key];
    if (v === undefined || v === "" || v === null) continue;
    if (f.type === "number" || f.type === "percentage") {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.key] = n;
    } else if (f.type === "select" && (v === "true" || v === "false")) {
      out[f.key] = v === "true";
    } else {
      out[f.key] = v;
    }
  }
  if (spec.arrayField) {
    const rows = Array.isArray(raw[spec.arrayField.key]) ? raw[spec.arrayField.key] : [];
    out[spec.arrayField.key] = rows.map((row: any) => {
      const cleaned: Record<string, any> = {};
      for (const c of spec.arrayField!.columns) {
        const v = row?.[c.key];
        if (v === undefined || v === "" || v === null) {
          if (c.allowOpenEnded) cleaned[c.key] = null;
          continue;
        }
        if (c.type === "number" || c.type === "percentage") {
          const n = Number(v);
          if (Number.isFinite(n)) cleaned[c.key] = n;
        } else {
          cleaned[c.key] = v;
        }
      }
      return cleaned;
    });
  }
  return out;
}

/**
 * Convert a `rule_name` to a stable machine code suitable for `rule_code`.
 */
export function suggestRuleCode(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}