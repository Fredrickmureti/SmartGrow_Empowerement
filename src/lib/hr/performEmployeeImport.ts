/**
 * performEmployeeImport — pure async orchestrator for a single imported
 * employee row. Extracted from `Employees.tsx` so it can be unit-tested with
 * an injected Supabase client and `createEmployee` mock.
 *
 * Pipeline:
 *   1. Split the row into core / statutory / custom buckets.
 *   2. Resolve natural keys (department / position / location / manager email)
 *      to FK IDs via `resolveEmployeeNaturalKeys`.
 *   3. Call `createEmployee(payload)`.
 *   4. Insert statutory identifiers into `employee_statutory_identifiers`.
 *   5. Look up `entity_field_configs` IDs and insert custom values into
 *      `entity_field_values`.
 *
 * Warnings (natural-key misses, insert failures) are collected and returned
 * so the caller can surface them in one toast.
 */
import { splitImportedEmployeeRow } from "@/lib/hr/employeeImportSchema";
import { resolveEmployeeNaturalKeys } from "@/lib/hr/resolveEmployeeNaturalKeys";
import { buildImportEmployeePayload } from "@/lib/hr/buildEmployeePayload";

type SupabaseLike = {
  from: (table: string) => any;
};

export interface PerformEmployeeImportDeps {
  supabase: SupabaseLike;
  createEmployee: (payload: Record<string, unknown>) => Promise<{ id?: string } | null | undefined>;
  organizationId: string;
  businessId?: string | null;
  /** Optional override for resolver — used by tests to avoid live lookups. */
  resolveNaturalKeys?: typeof resolveEmployeeNaturalKeys;
}

export interface PerformEmployeeImportResult {
  employeeId: string | null;
  warnings: string[];
}

export async function performEmployeeImport(
  row: Record<string, unknown>,
  deps: PerformEmployeeImportDeps,
): Promise<PerformEmployeeImportResult> {
  const warnings: string[] = [];
  const split = splitImportedEmployeeRow(row);

  const resolver = deps.resolveNaturalKeys ?? resolveEmployeeNaturalKeys;
  const resolved = await resolver({
    organizationId: deps.organizationId,
    businessId: deps.businessId ?? null,
    department: split.core.department as string | undefined,
    position: split.core.position as string | undefined,
    workLocation: split.core.work_location as string | undefined,
    managerEmail: split.core.manager_email as string | undefined,
  });
  warnings.push(...resolved.warnings);

  // Strip natural-key columns from the core payload before sending to the
  // employees table — those become FK IDs above.
  const {
    department: _d, position: _p, work_location: _w, manager_email: _m,
    ...corePayload
  } = split.core as Record<string, unknown>;

  const importPayload = {
    ...(buildImportEmployeePayload(corePayload) as Record<string, unknown>),
    department_id: resolved.department_id,
    job_position_id: resolved.job_position_id,
    work_location_id: resolved.work_location_id,
    manager_id: resolved.manager_id,
  };

  const created = await deps.createEmployee(importPayload);
  if (!created?.id) {
    return { employeeId: null, warnings };
  }
  const employeeId = created.id;

  // Statutory identifiers — pack-defined fields.
  if (split.statutory.length > 0) {
    const statRows = split.statutory.map((s) => ({
      employee_id: employeeId,
      organization_id: deps.organizationId,
      business_id: deps.businessId ?? null,
      identifier_type: s.identifier_type,
      identifier_value: s.identifier_value,
      is_active: true,
    }));
    const { error } = await deps.supabase
      .from("employee_statutory_identifiers")
      .insert(statRows);
    if (error) warnings.push(`Statutory identifiers not saved: ${error.message ?? error}`);
  }

  // Custom field values — tenant-defined fields.
  if (split.customFields.length > 0) {
    const keys = split.customFields.map((c) => c.field_key);
    const { data: configs, error: cfgErr } = await deps.supabase
      .from("entity_field_configs")
      .select("id, field_key")
      .eq("entity_type", "employee")
      .eq("organization_id", deps.organizationId)
      .in("field_key", keys);
    if (cfgErr) {
      warnings.push(`Custom fields not saved: ${cfgErr.message ?? cfgErr}`);
    } else {
      const idByKey = new Map<string, string>(
        ((configs || []) as Array<{ id: string; field_key: string }>).map((c) => [c.field_key, c.id]),
      );
      const missing = keys.filter((k) => !idByKey.has(k));
      if (missing.length > 0) {
        warnings.push(`Custom field(s) not configured: ${missing.join(", ")}`);
      }
      const valueRows = split.customFields
        .filter((c) => idByKey.has(c.field_key))
        .map((c) => ({
          entity_type: "employee",
          entity_id: employeeId,
          organization_id: deps.organizationId,
          business_id: deps.businessId ?? null,
          field_config_id: idByKey.get(c.field_key)!,
          field_key: c.field_key,
          field_value: c.field_value,
        }));
      if (valueRows.length > 0) {
        const { error } = await deps.supabase
          .from("entity_field_values")
          .insert(valueRows);
        if (error) warnings.push(`Custom field values not saved: ${error.message ?? error}`);
      }
    }
  }

  return { employeeId, warnings };
}
