// @ts-nocheck — Deno runtime
/**
 * employeeStatutoryProjection — SINGLE source of truth for spreading
 * `employee_statutory_identifiers` rows onto the per-employee context that
 * every payroll document generator consumes.
 *
 * Callers (locked by architecture test):
 *   - supabase/functions/generate-tax-certificate/index.ts
 *   - supabase/functions/generate-statutory-return/index.ts
 *
 * Rules:
 *   - Every stored `(identifier_type, identifier_value)` pair is projected
 *     onto the employee context under the exact lowercased key it is
 *     stored with (e.g. `tax_pin`, `nssf_number`, `shif_number`).
 *   - The same value is ALSO projected under an uppercased alias
 *     (`TAX_PIN`, `NSSF_NUMBER`, …). This lets pack templates authored
 *     against either convention resolve — a common pain point we hit
 *     when tenants installed a pack whose author wrote `KRA_PIN` while
 *     the DB stores `tax_pin`.
 *   - A pack-declared identifier NEVER shadows a system column already
 *     projected on the employee row (id, first_name, last_name, …).
 *   - Well-known tax-identifier aliases (`tax_id`, `tax_pin`, `tin`) are
 *     backfilled off whichever of them the pack actually stored, so that
 *     canonical templates addressing `employee.tax_id` continue to work
 *     for tenants whose pack stores `tax_pin`, and vice-versa. No
 *     country codes are baked in.
 */

export interface StatutoryIdentifierRow {
  employee_id: string;
  identifier_type: string;
  identifier_value: string | null;
}

/** Group identifier rows by employee_id → { identifier_type → value }. */
export function groupIdentifiersByEmployee(
  rows: StatutoryIdentifierRow[] | null | undefined,
): Map<string, Record<string, string | null>> {
  const out = new Map<string, Record<string, string | null>>();
  for (const r of rows ?? []) {
    if (!r?.employee_id || !r?.identifier_type) continue;
    const m = out.get(r.employee_id) ?? {};
    m[r.identifier_type] = r.identifier_value ?? null;
    out.set(r.employee_id, m);
  }
  return out;
}

/**
 * Mutates `emp` by projecting its statutory identifiers onto it, following
 * the rules above. Returns the same object for chaining.
 */
export function projectIdentifiersOntoEmployee(
  emp: Record<string, unknown>,
  identifiers: Record<string, string | null> | undefined,
): Record<string, unknown> {
  const ids = identifiers ?? {};

  // Pass 1: raw + uppercased projection, never shadowing existing keys.
  for (const [rawKey, value] of Object.entries(ids)) {
    const lower = rawKey.toLowerCase();
    const upper = rawKey.toUpperCase();
    if (!(lower in emp)) (emp as any)[lower] = value ?? null;
    if (upper !== lower && !(upper in emp)) (emp as any)[upper] = value ?? null;
  }

  // Pass 2: tax-identifier alias backfill.
  // If ANY of these canonical tax-id keys is populated, mirror it onto the
  // others so templates written against either convention resolve. Pack
  // authors have historically split between `tax_pin`, `tax_id`, and `tin`
  // depending on the country's terminology; the projection contract
  // guarantees all three point to the same value.
  const TAX_ALIASES = ["tax_pin", "tax_id", "tin"] as const;
  let taxValue: string | null = null;
  for (const k of TAX_ALIASES) {
    const v = (emp as any)[k];
    if (v != null && v !== "") {
      taxValue = String(v);
      break;
    }
  }
  if (taxValue != null) {
    for (const k of TAX_ALIASES) {
      if ((emp as any)[k] == null || (emp as any)[k] === "") {
        (emp as any)[k] = taxValue;
      }
      const upper = k.toUpperCase();
      if ((emp as any)[upper] == null || (emp as any)[upper] === "") {
        (emp as any)[upper] = taxValue;
      }
    }
  }

  return emp;
}

/**
 * Convenience: given the list of employee rows and the flat identifier
 * rows returned by a single `.from('employee_statutory_identifiers')`
 * fetch, return a new Map<employee_id, projectedEmployee> ready to feed
 * the source resolver.
 */
export function buildProjectedEmployeeMap<
  E extends { id: string } & Record<string, unknown>,
>(
  employees: E[] | null | undefined,
  identifierRows: StatutoryIdentifierRow[] | null | undefined,
): Map<string, E> {
  const grouped = groupIdentifiersByEmployee(identifierRows);
  const out = new Map<string, E>();
  for (const emp of employees ?? []) {
    const copy = { ...emp } as E;
    projectIdentifiersOntoEmployee(copy as any, grouped.get(emp.id));
    out.set(emp.id, copy);
  }
  return out;
}
