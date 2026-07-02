/**
 * Canonical contract for `localization_pack_return_templates.body`.
 *
 * `generate-statutory-return/index.ts` reads:
 *   - body.filters.rule_codes        (string[], required, min 1)
 *   - body.filters.payslip_status    (string[], optional)
 *   - body.columns                   ({ key, source, label?, format? }[], required, min 1)
 *   - body.group_by                  (string[], default ["employee_id"])
 *   - body.totals                    (string[], optional — must reference column keys)
 *   - body.reconciliation            ({ rule_code }, optional)
 *
 * Used by:
 *   - `validate-localization-payload` (kind: 'return_template') under Deno
 *   - `src/test/localization/schema-validation.test.ts` under Node/Vitest
 *
 * Keep ESM-pure (no Deno globals, no npm: at module scope).
 */

import { validateAgainstSchema } from "./validateAgainstSchema.ts";
import { isKnownSource, isNumericSource } from "./returnSourceResolver.ts";

/**
 * System sources the runtime knows how to read directly from the employee
 * record or from aggregated payslip line sums.
 *
 * Country-specific statutory identifiers (e.g. `employee.tax_pin`,
 * `employee.nssf_number`, `employee.shif_number`, or any other identifier
 * type a localization pack registers) are accepted dynamically by the
 * runtime — it spreads every `(identifier_type, identifier_value)` pair
 * from `employee_statutory_identifiers` onto the employee context. To stay
 * country-agnostic we therefore do NOT hardcode identifier names here;
 * validation accepts any `employee.<snake_case>` source.
 */
export const KNOWN_SYSTEM_COLUMN_SOURCES = [
  "employee.full_name",
  "employee.first_name",
  "employee.last_name",
  "employee.employee_number",
  "employee.national_id",
  "employee.branch_id",
  "sum_employee_amount",
  "sum_employer_amount",
  "sum_taxable_amount",
  "sum_basic_pay",
  "sum_allowances",
] as const;

/**
 * True iff the runtime knows how to read this source. Delegates to
 * the shared resolver so the validator and renderer can never drift.
 */
export function isKnownColumnSource(source: string): boolean {
  return isKnownSource(source);
}

/**
 * Back-compat export. New code should call `isNumericSource()` from
 * the resolver — it understands `sum_rule.*` and `sum_taxable_minus_rules:*`.
 */
export const NUMERIC_SOURCES = new Set([
  "sum_employee_amount",
  "sum_employer_amount",
  "sum_taxable_amount",
  "sum_basic_pay",
  "sum_allowances",
]);

export const PAYSLIP_STATUS_VALUES = ["draft", "validated", "paid", "posted"] as const;

export const GROUP_BY_VALUES = ["employee_id", "aggregate"] as const;

export const COLUMN_FORMATS = ["text", "number", "currency", "date"] as const;

export const RETURN_TEMPLATE_BODY_SCHEMA = {
  type: "object",
  required: ["filters", "columns"],
  properties: {
    filters: {
      type: "object",
      required: ["rule_codes"],
      properties: {
        rule_codes: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
        payslip_status: {
          type: "array",
          items: { type: "string", enum: [...PAYSLIP_STATUS_VALUES] },
        },
      },
    },
    columns: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "source"],
        properties: {
          key: { type: "string", minLength: 1, maxLength: 64 },
          source: { type: "string", minLength: 1 },
          label: { type: "string", maxLength: 120 },
          format: { type: "string", enum: [...COLUMN_FORMATS] },
          width: { type: "number", minimum: 0 },
        },
      },
    },
    group_by: {
      type: "array",
      items: { type: "string", enum: [...GROUP_BY_VALUES] },
    },
    totals: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    reconciliation: {
      type: "object",
      properties: {
        rule_code: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  },
} as const;

/**
 * Cross-field rules JSON Schema can't express:
 *   - filters.rule_codes must be non-empty
 *   - columns must be non-empty and have unique keys
 *   - every entry in totals must match a column key
 *   - totals entries must reference numeric-source columns (warning, not error,
 *     because a custom column key could be added later)
 */
export function validateReturnTemplateBody(body: any): { errors: string[]; warnings: string[] } {
  const errors = validateAgainstSchema(body, RETURN_TEMPLATE_BODY_SCHEMA);
  const warnings: string[] = [];
  if (errors.length) return { errors, warnings };

  const ruleCodes: string[] = body?.filters?.rule_codes ?? [];
  if (!ruleCodes.length) errors.push("$.filters.rule_codes: at least one rule code is required");

  const columns = (body?.columns ?? []) as Array<{ key: string; source: string }>;
  if (!columns.length) errors.push("$.columns: at least one column is required");

  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.key)) errors.push(`$.columns: duplicate column key '${c.key}'`);
    seen.add(c.key);
    if (!isKnownColumnSource(c.source)) {
      warnings.push(
        `$.columns.${c.key}: source '${c.source}' is not a recognised system source and does not match 'employee.<key>' — runtime will fall back to empty string`,
      );
    }
  }

  const totals: string[] = body?.totals ?? [];
  for (const t of totals) {
    const col = columns.find((c) => c.key === t);
    if (!col) errors.push(`$.totals: '${t}' does not match any column key`);
    else if (!isNumericSource(col.source)) {
      warnings.push(
        `$.totals: '${t}' references column with non-numeric source '${col.source}'; sum will coerce to 0`,
      );
    }
  }

  return { errors, warnings };
}
